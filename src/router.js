function getBearerToken(headers) {
  const authorization = headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function withV1Path(baseUrl, path) {
  const cleanPath = path.replace(/^\/+/, "");
  return `${baseUrl}/${cleanPath}`;
}

function hasSpecifiedModel(body) {
  return Boolean(body && typeof body === "object" && typeof body.model === "string" && body.model.trim());
}

function isMultimodalModel(config, model) {
  return typeof model === "string" && config.multimodalModelSet.has(model.toLowerCase());
}

function looksLikeImageUrl(value) {
  return typeof value === "string" && (
    /^data:image\//i.test(value) ||
    /^https?:\/\//i.test(value)
  );
}

function hasMultimodalInput(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasMultimodalInput);
  }

  if (value.type === "image_url" && value.image_url) {
    if (typeof value.image_url === "string") {
      return looksLikeImageUrl(value.image_url);
    }
    if (typeof value.image_url === "object" && looksLikeImageUrl(value.image_url.url)) {
      return true;
    }
  }

  if (value.type === "input_image" && looksLikeImageUrl(value.image_url || value.url)) {
    return true;
  }

  return Object.values(value).some(hasMultimodalInput);
}

function latestUserMessage(items) {
  if (!Array.isArray(items)) {
    return null;
  }

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && typeof item === "object" && item.role === "user") {
      return item;
    }
  }

  return null;
}

function hasCurrentUserMultimodalInput(body) {
  if (!body || typeof body !== "object") {
    return false;
  }

  const latestResponseUserMessage = latestUserMessage(body.input);
  if (latestResponseUserMessage) {
    return hasMultimodalInput(latestResponseUserMessage.content);
  }

  const latestChatUserMessage = latestUserMessage(body.messages);
  if (latestChatUserMessage) {
    return hasMultimodalInput(latestChatUserMessage.content);
  }

  return hasMultimodalInput(body);
}

function requireUrl(value, label) {
  if (!value) {
    throw Object.assign(new Error(`${label} is required for the selected route mode`), {
      statusCode: 500
    });
  }
  return value.replace(/\/+$/, "");
}

export function decideRoute({ config, body, headers }) {
  const incomingKey = getBearerToken(headers);
  const specifiedModel = hasSpecifiedModel(body) ? body.model.trim() : "";
  const multimodal = isMultimodalModel(config, specifiedModel);
  const multimodalPayload = hasCurrentUserMultimodalInput(body);

  if (!specifiedModel) {
    return {
      baseUrl: config.defaultBackendBaseUrl,
      apiKey: incomingKey,
      model: null,
      reason: "passthrough-unspecified-model"
    };
  }

  if (config.routeMode === "custom-all") {
    return {
      baseUrl: requireUrl(config.customBackendBaseUrl, "CUSTOM_BACKEND_BASE_URL"),
      apiKey: config.customBackendApiKey || incomingKey,
      model: config.customBackendModel || specifiedModel,
      reason: "custom-all"
    };
  }

  if (config.routeMode === "custom-vision" && multimodal) {
    if (multimodalPayload) {
      return {
        baseUrl: requireUrl(config.visionBackendBaseUrl, "VISION_BACKEND_BASE_URL"),
        apiKey: config.visionBackendApiKey || incomingKey,
        model: config.visionBackendModel || specifiedModel,
        reason: "custom-vision"
      };
    }
    return {
      baseUrl: config.defaultBackendBaseUrl,
      apiKey: incomingKey,
      model: null,
      reason: "passthrough-text-alias"
    };
  }

  return {
    baseUrl: config.defaultBackendBaseUrl,
    apiKey: incomingKey,
    model: multimodal && multimodalPayload ? config.visionBackendModel : null,
    reason: multimodal && multimodalPayload ? "default-multimodal" : "passthrough"
  };
}

export function buildUpstreamRequest({ originalPath, body, headers, route }) {
  const upstreamHeaders = new Headers(headers);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");
  upstreamHeaders.delete("connection");
  upstreamHeaders.delete("accept-encoding");

  if (route.apiKey) {
    upstreamHeaders.set("authorization", `Bearer ${route.apiKey}`);
  } else {
    upstreamHeaders.delete("authorization");
  }

  const nextBody = route.model ? { ...body, model: route.model } : body;

  return {
    url: withV1Path(route.baseUrl, originalPath),
    headers: upstreamHeaders,
    body: JSON.stringify(nextBody)
  };
}

export const internals = {
  getBearerToken,
  hasSpecifiedModel,
  hasMultimodalInput,
  hasCurrentUserMultimodalInput,
  isMultimodalModel,
  withV1Path
};
