# deepseekglm-vision

[English](README.md) | [简体中文](README.zh.md)

一个 OpenAI 兼容的多模态路由中间件，用于在文本模型和视觉模型之间自动分流。

这个项目尽量保持简单：它位于客户端和 OpenAI 兼容后端之间，只检查当前请求是否需要视觉模型，其它参数尽量原样转发。

## 功能概览

默认后端：

```env
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
```

以下模型名会被当作多模态别名，大小写不敏感：

- `GLM-5.1`
- `GLM-5`
- `deepseek-v4-pro`
- `deepseek-v4-flash`

当请求满足以下两个条件时，中间件会把上游请求里的 `model` 改成 `gpt-5.4`：

1. `model` 命中上面的任一别名，不论大小写
2. 最新一条用户消息包含图片输入

纯文本请求不会被改写。即使 `model` 是 `GLM-5` 或 `glm-5.1`，只要最新用户消息没有图片，就会原样透传到默认后端。

## KEY 处理方式

中间件支持三种 KEY 处理方式，对应三种路由模式。

### 1. KEY 透传模式

这是 `ROUTE_MODE=default` 下的默认行为。

```env
ROUTE_MODE=default
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
```

中间件不保存、不替换、不生成 KEY。客户端请求里传入的 `Authorization: Bearer ...` 或 `x-api-key: ...` 会原样转发给 `127.0.0.1:8090` 后端。

默认模式下，无论是纯文本请求还是带图片请求，KEY 都是透传的。带图片请求如果触发模型改写，也只会改顶层 `model`，不会改 `Authorization`。

也就是说：调用中间件使用什么 KEY，后端 8090 就收到什么 KEY。

### 2. 自定义多模态后端 KEY

适用于只有图片请求需要走独立多模态后端，并且该后端有自己的 KEY。

```env
ROUTE_MODE=custom-vision
VISION_BACKEND_BASE_URL=https://vision-api.example.com/v1
VISION_BACKEND_API_KEY=sk-vision
```

行为：

- 纯文本请求继续走 `DEFAULT_BACKEND_BASE_URL`，并使用客户端传入的 KEY。
- 最新用户消息带图片，并且模型名命中多模态别名时，请求会走 `VISION_BACKEND_BASE_URL`。
- 如果设置了 `VISION_BACKEND_API_KEY`，多模态后端使用这个 KEY。
- 如果 `VISION_BACKEND_API_KEY` 为空，多模态后端也复用客户端传入的 KEY。

### 3. 自定义全量后端 KEY

适用于文本和多模态请求都要走同一个自定义后端，并且该后端有自己的 KEY。

```env
ROUTE_MODE=custom-all
CUSTOM_BACKEND_BASE_URL=https://api.example.com/v1
CUSTOM_BACKEND_API_KEY=sk-custom
```

行为：

- 只要请求里指定了 `model`，就会走 `CUSTOM_BACKEND_BASE_URL`。
- 如果设置了 `CUSTOM_BACKEND_API_KEY`，上游请求使用这个 KEY，替换客户端传入的 KEY。
- 如果 `CUSTOM_BACKEND_API_KEY` 为空，则继续复用客户端传入的 KEY。

## 多轮对话规则

中间件只检查本次请求里的最后一条 `role=user` 消息：

- `/v1/chat/completions`：检查 `messages` 里最后一条用户消息
- `/v1/responses`：检查 `input` 里最后一条用户消息
- `/v1/messages`：兼容 Claude Messages API，检查 `messages` 里最后一条用户消息

这样可以避免一个常见问题：第一轮对话带图片，后续追问是纯文本。如果历史消息里还保留着旧图片，中间件不会因为旧图片而继续切到视觉模型。

## 支持的协议和接口

中间件同时兼容 OpenAI 风格和 Claude / Anthropic 风格的请求结构。

支持的 JSON 接口包括：

- OpenAI Chat Completions：`/v1/chat/completions`
- OpenAI Responses API：`/v1/responses`
- Claude Messages API：`/v1/messages`
- 其它 OpenAI 兼容的 `/v1/*` 路径会透传到默认后端

鉴权头处理：

- OpenAI 风格：`Authorization: Bearer <key>`
- Claude 风格：`x-api-key: <key>`

在 KEY 透传模式下，中间件会保留传入的鉴权头类型。也就是说，Claude 请求传入 `x-api-key`，上游也会收到 `x-api-key`，不会被转换成 `Authorization`。

## 支持的图片格式

兼容 OpenAI 和 Claude 常见的图片输入格式，并且不会下载、解析或改写图片地址。

### Chat Completions 格式

```json
{
  "model": "GLM-5.1",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "描述这张图片" },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://example.com/image.png",
            "detail": "high"
          }
        }
      ]
    }
  ]
}
```

### Responses API 格式

```json
{
  "model": "glm-5.1",
  "input": [
    {
      "role": "user",
      "type": "message",
      "content": [
        { "type": "input_text", "text": "描述这张图片" },
        { "type": "input_image", "image_url": "data:image/png;base64,..." }
      ]
    }
  ]
}
```

也支持 base64 data URL：

```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/png;base64,iVBORw0KGgo..."
  }
}
```

### Claude Messages API 格式

```json
{
  "model": "deepseek-v4-flash",
  "max_tokens": 512,
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "描述这张图片" },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": "..."
          }
        }
      ]
    }
  ]
}
```

也支持 Claude 的 URL 图片来源：

```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://example.com/image.png"
  }
}
```

## 路由模式

### 默认模式：`default`

```env
ROUTE_MODE=default
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
VISION_BACKEND_MODEL=gpt-5.4
```

行为：

- 纯文本请求：原样转发到 `DEFAULT_BACKEND_BASE_URL`
- 最新用户消息含图片，并且模型名命中别名：转发到 `DEFAULT_BACKEND_BASE_URL`，同时把 `model` 改成 `VISION_BACKEND_MODEL`
- 上游调用复用传入的 API Key

### 自定义多模态后端：`custom-vision`

```env
ROUTE_MODE=custom-vision
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
VISION_BACKEND_BASE_URL=https://vision-api.example.com/v1
VISION_BACKEND_API_KEY=sk-vision
VISION_BACKEND_MODEL=gpt-5.4
```

行为：

- 纯文本请求：原样转发到 `DEFAULT_BACKEND_BASE_URL`
- 最新用户消息含图片，并且模型名命中别名：转发到 `VISION_BACKEND_BASE_URL`
- 如果设置了 `VISION_BACKEND_API_KEY`，上游调用使用它；否则复用传入的 API Key

### 自定义全量后端：`custom-all`

```env
ROUTE_MODE=custom-all
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
CUSTOM_BACKEND_BASE_URL=https://api.example.com/v1
CUSTOM_BACKEND_API_KEY=sk-custom
CUSTOM_BACKEND_MODEL=
```

行为：

- 只要请求指定了 `model`，就转发到 `CUSTOM_BACKEND_BASE_URL`
- 如果设置了 `CUSTOM_BACKEND_API_KEY`，上游调用使用它；否则复用传入的 API Key
- 如果设置了 `CUSTOM_BACKEND_MODEL`，上游请求里的 `model` 会被改成该值

## 本地运行

需要 Node.js 18.17 或更高版本。

```bash
cp .env.example .env
npm test
npm start
```

健康检查：

```bash
curl http://127.0.0.1:8080/health
```

## 请求示例

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.1","messages":[{"role":"user","content":[{"type":"text","text":"描述"},{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}'
```

如果最新用户消息包含图片，上游实际收到的 `model` 会是 `gpt-5.4`。除顶层 `model` 外，其它请求参数保持不变。

## systemd 部署

推荐部署目录：

```bash
/www/wwwroot/deepseekglm-vision
```

服务文件示例：

```ini
[Unit]
Description=deepseekglm-vision middleware
After=network.target

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/deepseekglm-vision
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启动命令：

```bash
systemctl daemon-reload
systemctl enable --now deepseekglm-vision
systemctl status deepseekglm-vision
```

## NGINX 反代分流示例

如果原站点已经反代到 `127.0.0.1:8090`，可以只把 OpenAI API 路径转给本中间件，其它路径保持不变。

```nginx
location ^~ /v1/
{
    proxy_pass http://127.0.0.1:18080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}

location ^~ /
{
    proxy_pass http://127.0.0.1:8090;
}
```

## 测试

```bash
npm test
```

测试覆盖：

- 模型别名大小写不敏感匹配
- 纯文本别名请求不切换模型
- 图片请求切换到 `gpt-5.4`
- OpenAI `image_url` 和 `input_image` 兼容
- 多轮对话中历史图片不影响最新纯文本追问

## 许可证

MIT
