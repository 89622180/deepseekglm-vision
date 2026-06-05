# deepseekglm-vision

OpenAI-compatible multimodal routing middleware for model alias switching.

This project is intentionally small: it sits between your client and an OpenAI-compatible backend, inspects only the current request, and forwards everything else as-is. It is designed for deployments where a text backend and a vision-capable backend share the same API shape.

## What It Does

By default, requests are forwarded to:

```env
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
```

The following model names are treated as multimodal aliases, case-insensitively:

- `GLM-5.1`
- `GLM-5`
- `deepseek-v4-pro`
- `deepseek-v4-flash`

When the latest user message contains an image input and the requested model matches one of those aliases, the middleware rewrites the upstream `model` to:

```text
gpt-5.4
```

Text-only requests are not rewritten, even if the model name is one of the aliases. They are passed through to the default backend unchanged.

## Important Routing Detail

For multi-turn conversations, the middleware only checks the latest `role=user` message:

- `/v1/chat/completions`: checks the last user item in `messages`
- `/v1/responses`: checks the last user item in `input`

This prevents an old image in conversation history from forcing later text-only follow-up messages onto the vision model.

## Supported Image Formats

The middleware recognizes common OpenAI-compatible image payloads and preserves them unchanged.

Chat Completions style:

```json
{
  "model": "GLM-5.1",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this image" },
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

Responses API style:

```json
{
  "model": "glm-5.1",
  "input": [
    {
      "role": "user",
      "type": "message",
      "content": [
        { "type": "input_text", "text": "Describe this image" },
        { "type": "input_image", "image_url": "data:image/png;base64,..." }
      ]
    }
  ]
}
```

## Route Modes

### `default`

```env
ROUTE_MODE=default
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
VISION_BACKEND_MODEL=gpt-5.4
```

Behavior:

- Text-only requests: pass through to `DEFAULT_BACKEND_BASE_URL`
- Latest user message contains image + alias model: pass to `DEFAULT_BACKEND_BASE_URL`, rewrite `model` to `VISION_BACKEND_MODEL`
- Incoming API key is reused for upstream calls

### `custom-vision`

```env
ROUTE_MODE=custom-vision
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
VISION_BACKEND_BASE_URL=https://vision-api.example.com/v1
VISION_BACKEND_API_KEY=sk-vision
VISION_BACKEND_MODEL=gpt-5.4
```

Behavior:

- Text-only requests: pass through to `DEFAULT_BACKEND_BASE_URL`
- Latest user message contains image + alias model: route to `VISION_BACKEND_BASE_URL`
- `VISION_BACKEND_API_KEY` is used if set; otherwise the incoming API key is reused

### `custom-all`

```env
ROUTE_MODE=custom-all
DEFAULT_BACKEND_BASE_URL=http://127.0.0.1:8090/v1
CUSTOM_BACKEND_BASE_URL=https://api.example.com/v1
CUSTOM_BACKEND_API_KEY=sk-custom
CUSTOM_BACKEND_MODEL=
```

Behavior:

- Any request with a `model` is routed to `CUSTOM_BACKEND_BASE_URL`
- `CUSTOM_BACKEND_API_KEY` is used if set; otherwise the incoming API key is reused
- If `CUSTOM_BACKEND_MODEL` is set, the upstream `model` is rewritten to that value

## Install

Requires Node.js 18.17 or newer.

```bash
cp .env.example .env
npm test
npm start
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Example Request

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-test" \
  -H "Content-Type: application/json" \
  -d '{"model":"GLM-5.1","messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}'
```

The upstream request will keep all payload fields unchanged except the top-level `model`, which becomes `gpt-5.4`.

## systemd Deployment

Example install path:

```bash
/www/wwwroot/deepseekglm-vision
```

Service file:

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

Commands:

```bash
systemctl daemon-reload
systemctl enable --now deepseekglm-vision
systemctl status deepseekglm-vision
```

## NGINX Reverse Proxy Split

If your existing site already proxies to `127.0.0.1:8090`, you can split only OpenAI API traffic to this middleware while keeping all other paths unchanged.

Example:

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

## Tests

```bash
npm test
```

The test suite covers:

- Case-insensitive model alias matching
- Text-only alias requests staying on the text backend
- Image requests being rewritten to `gpt-5.4`
- OpenAI `image_url` and `input_image` compatibility
- Multi-turn history where old image turns must not affect the latest text-only turn

## License

MIT
