import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpstreamRequest, decideRoute, internals } from "../src/router.js";

function config(overrides = {}) {
  return {
    routeMode: "default",
    defaultBackendBaseUrl: "http://127.0.0.1:8090/v1",
    multimodalModelSet: new Set(["glm-5.1", "glm-5", "deepseek-v4-pro", "deepseek-v4-flash"]),
    visionBackendBaseUrl: "",
    visionBackendApiKey: "",
    visionBackendModel: "gpt-5.4",
    customBackendBaseUrl: "",
    customBackendApiKey: "",
    customBackendModel: "",
    ...overrides
  };
}

test("matches multimodal model case-insensitively", () => {
  assert.equal(internals.isMultimodalModel(config(), "gLm-5.1"), true);
  assert.equal(internals.isMultimodalModel(config(), "DEEPSEEK-V4-FLASH"), true);
});

test("detects OpenAI image inputs", () => {
  assert.equal(internals.hasMultimodalInput({ type: "image_url", image_url: { url: "https://example.com/a.png" } }), true);
  assert.equal(internals.hasMultimodalInput({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } }), true);
  assert.equal(internals.hasMultimodalInput({ type: "input_image", image_url: "https://example.com/a.png" }), true);
  assert.equal(internals.hasMultimodalInput({ role: "user", content: "hello" }), false);
});

test("detects multimodal input only in the latest user turn", () => {
  const historyImageThenText = {
    input: [
      {
        role: "user",
        type: "message",
        content: [
          { type: "input_text", text: "describe" },
          { type: "input_image", image_url: "data:image/png;base64,abc" }
        ]
      },
      {
        role: "assistant",
        type: "message",
        content: [{ type: "output_text", text: "done" }]
      },
      {
        role: "user",
        type: "message",
        content: [{ type: "input_text", text: "continue with text only" }]
      }
    ]
  };

  const latestImage = {
    input: [
      { role: "user", type: "message", content: [{ type: "input_text", text: "hello" }] },
      {
        role: "user",
        type: "message",
        content: [
          { type: "input_text", text: "describe" },
          { type: "input_image", image_url: "https://example.com/a.png" }
        ]
      }
    ]
  };

  assert.equal(internals.hasCurrentUserMultimodalInput(historyImageThenText), false);
  assert.equal(internals.hasCurrentUserMultimodalInput(latestImage), true);
});

test("unspecified model passthroughs to default backend with incoming key", () => {
  const route = decideRoute({
    config: config(),
    body: { messages: [] },
    headers: new Headers({ authorization: "Bearer incoming-key" })
  });

  assert.deepEqual(route, {
    baseUrl: "http://127.0.0.1:8090/v1",
    apiKey: "incoming-key",
    model: null,
    reason: "passthrough-unspecified-model"
  });
});

test("default mode passthroughs text-only multimodal alias without rewriting model", () => {
  const route = decideRoute({
    config: config(),
    body: { model: "gLm-5", temperature: 0.2, messages: [{ role: "user", content: "hello" }] },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "http://127.0.0.1:8090/v1");
  assert.equal(route.apiKey, "user-key");
  assert.equal(route.model, null);
  assert.equal(route.reason, "passthrough");
});

test("default mode routes image payload with multimodal alias to gpt-5.4 case-insensitively", () => {
  const route = decideRoute({
    config: config(),
    body: {
      model: "gLm-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://example.com/a.png" } }
          ]
        }
      ]
    },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "http://127.0.0.1:8090/v1");
  assert.equal(route.apiKey, "user-key");
  assert.equal(route.model, "gpt-5.4");
  assert.equal(route.reason, "default-multimodal");
});

test("default mode ignores images from earlier Responses API turns", () => {
  const route = decideRoute({
    config: config(),
    body: {
      model: "GLM-5.1",
      input: [
        {
          role: "user",
          type: "message",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "data:image/png;base64,abc" }
          ]
        },
        { role: "assistant", type: "message", content: [{ type: "output_text", text: "done" }] },
        { role: "user", type: "message", content: [{ type: "input_text", text: "now answer text only" }] }
      ]
    },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "http://127.0.0.1:8090/v1");
  assert.equal(route.apiKey, "user-key");
  assert.equal(route.model, null);
  assert.equal(route.reason, "passthrough");
});

test("custom-vision mode routes only image payloads to custom vision backend", () => {
  const route = decideRoute({
    config: config({
      routeMode: "custom-vision",
      visionBackendBaseUrl: "https://vision.example/v1",
      visionBackendApiKey: "vision-key",
      visionBackendModel: "actual-vision-model"
    }),
    body: {
      model: "deepseek-v4-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
          ]
        }
      ]
    },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "https://vision.example/v1");
  assert.equal(route.apiKey, "vision-key");
  assert.equal(route.model, "actual-vision-model");
});

test("custom-vision mode passthroughs text-only multimodal alias", () => {
  const route = decideRoute({
    config: config({
      routeMode: "custom-vision",
      visionBackendBaseUrl: "https://vision.example/v1",
      visionBackendApiKey: "vision-key",
      visionBackendModel: "actual-vision-model"
    }),
    body: { model: "deepseek-v4-pro", messages: [{ role: "user", content: "hello" }] },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "http://127.0.0.1:8090/v1");
  assert.equal(route.apiKey, "user-key");
  assert.equal(route.model, null);
  assert.equal(route.reason, "passthrough-text-alias");
});

test("custom-all mode routes specified models to custom backend", () => {
  const route = decideRoute({
    config: config({
      routeMode: "custom-all",
      customBackendBaseUrl: "https://custom.example/v1",
      customBackendApiKey: "custom-key"
    }),
    body: { model: "anything" },
    headers: new Headers({ authorization: "Bearer user-key" })
  });

  assert.equal(route.baseUrl, "https://custom.example/v1");
  assert.equal(route.apiKey, "custom-key");
  assert.equal(route.model, "anything");
});

test("buildUpstreamRequest preserves non-model parameters", () => {
  const upstream = buildUpstreamRequest({
    originalPath: "chat/completions",
    body: { model: "GLM-5", temperature: 0.1, messages: [{ role: "user", content: "hi" }] },
    headers: new Headers({ authorization: "Bearer old-key", "content-type": "application/json" }),
    route: {
      baseUrl: "http://127.0.0.1:8090/v1",
      apiKey: "new-key",
      model: null
    }
  });

  assert.equal(upstream.url, "http://127.0.0.1:8090/v1/chat/completions");
  assert.equal(upstream.headers.get("authorization"), "Bearer new-key");
  assert.deepEqual(JSON.parse(upstream.body), {
    model: "GLM-5",
    temperature: 0.1,
    messages: [{ role: "user", content: "hi" }]
  });
});

test("buildUpstreamRequest preserves OpenAI image_url content while rewriting only model", () => {
  const imageUrlRequest = {
    model: "GLM-5.1",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          {
            type: "image_url",
            image_url: {
              url: "https://example.com/cat.png",
              detail: "high"
            }
          },
          {
            type: "image_url",
            image_url: {
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
            }
          }
        ]
      }
    ]
  };

  const upstream = buildUpstreamRequest({
    originalPath: "chat/completions",
    body: imageUrlRequest,
    headers: new Headers({ authorization: "Bearer user-key", "content-type": "application/json" }),
    route: {
      baseUrl: "http://127.0.0.1:8090/v1",
      apiKey: "user-key",
      model: "gpt-5.4"
    }
  });

  assert.deepEqual(JSON.parse(upstream.body), {
    ...imageUrlRequest,
    model: "gpt-5.4"
  });
});
