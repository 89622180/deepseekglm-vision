function getIncomingApiKey(headers) {
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) {
    return {
      key: xApiKey.trim(),
      header: "x-api-key"
    };
  }

  const authorization = headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return {
    key: match ? match[1].trim() : "",
    header: "authorization"
  };
}

function getBearerToken(headers) {
  const incoming = getIncomingApiKey(headers);
  return incoming.header === "authorization" ? incoming.key : "";
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

function isVisionFallbackModel(config, model) {
  return Boolean(
    config.visionFallbackEnabled &&
    typeof model === "string" &&
    config.visionFallbackModelSet?.has(model.toLowerCase())
  );
}

function isResponsesToChatModel(config, model) {
  return typeof model === "string" && config.responsesToChatModelSet?.has(model.toLowerCase());
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

  if (value.type === "image" && value.source) {
    if (typeof value.source === "object") {
      if (value.source.type === "base64" && typeof value.source.data === "string" && value.source.data) {
        return true;
      }
      if (value.source.type === "url" && looksLikeImageUrl(value.source.url)) {
        return true;
      }
      if (looksLikeImageUrl(value.source.url)) {
        return true;
      }
    }
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

function normalizeRole(role) {
  return ["system", "user", "assistant", "tool"].includes(role) ? role : "user";
}

function convertResponsesContentPart(part) {
  if (!part || typeof part !== "object") {
    return part;
  }

  if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
    return { type: "text", text: part.text };
  }

  if (part.type === "input_image") {
    const url = part.image_url || part.url;
    const imageUrl = typeof url === "object" ? url : { url };
    if (part.detail && !imageUrl.detail) {
      imageUrl.detail = part.detail;
    }
    return { type: "image_url", image_url: imageUrl };
  }

  return part;
}

function simplifyChatContent(parts) {
  if (!Array.isArray(parts)) {
    return parts;
  }

  if (parts.every((part) => typeof part === "string")) {
    return parts.join("\n");
  }

  if (parts.every((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")) {
    return parts.map((part) => part.text).join("\n");
  }

  return parts;
}

function convertResponsesContent(content) {
  if (Array.isArray(content)) {
    return simplifyChatContent(content.map(convertResponsesContentPart));
  }

  if (content && typeof content === "object") {
    return simplifyChatContent([convertResponsesContentPart(content)]);
  }

  return content === undefined || content === null ? "" : content;
}

function convertResponsesInputToMessages(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: convertResponsesContent(input) }];
  }

  const messages = [];
  const pendingUserParts = [];

  const flushPendingUserParts = () => {
    if (pendingUserParts.length) {
      messages.push({ role: "user", content: simplifyChatContent([...pendingUserParts]) });
      pendingUserParts.length = 0;
    }
  };

  for (const item of input) {
    if (item && typeof item === "object" && (item.role || item.type === "message")) {
      flushPendingUserParts();
      messages.push({
        role: normalizeRole(item.role),
        content: convertResponsesContent(item.content)
      });
      continue;
    }

    const convertedItem = convertResponsesContentPart(item);
    if (Array.isArray(convertedItem)) {
      pendingUserParts.push(...convertedItem);
    } else {
      pendingUserParts.push(convertedItem);
    }
  }

  flushPendingUserParts();
  return messages;
}

function convertResponsesBodyToChat(body) {
  const { input, instructions, max_output_tokens: maxOutputTokens, ...nextBody } = body;
  const messages = convertResponsesInputToMessages(input);

  if (typeof instructions === "string" && instructions.trim()) {
    messages.unshift({ role: "system", content: instructions });
  }

  if (maxOutputTokens !== undefined && nextBody.max_tokens === undefined) {
    nextBody.max_tokens = maxOutputTokens;
  }

  nextBody.messages = messages;
  return nextBody;
}

export function decideRoute({ config, body, headers }) {
  const incoming = getIncomingApiKey(headers);
  const incomingKey = incoming.key;
  const specifiedModel = hasSpecifiedModel(body) ? body.model.trim() : "";
  const multimodal = isMultimodalModel(config, specifiedModel);
  const visionFallback = isVisionFallbackModel(config, specifiedModel);
  const responsesToChat = isResponsesToChatModel(config, specifiedModel);
  const multimodalPayload = hasCurrentUserMultimodalInput(body);

  if (!specifiedModel) {
    return {
      baseUrl: config.defaultBackendBaseUrl,
      apiKey: incomingKey,
      apiKeyHeader: incoming.header,
      model: null,
      responsesToChat: false,
      reason: "passthrough-unspecified-model"
    };
  }

  if (config.routeMode === "custom-all") {
    return {
      baseUrl: requireUrl(config.customBackendBaseUrl, "CUSTOM_BACKEND_BASE_URL"),
      apiKey: config.customBackendApiKey || incomingKey,
      apiKeyHeader: incoming.header,
      model: config.customBackendModel || specifiedModel,
      responsesToChat,
      reason: "custom-all"
    };
  }

  if (visionFallback && multimodalPayload) {
    return {
      baseUrl: config.defaultBackendBaseUrl,
      apiKey: incomingKey,
      apiKeyHeader: incoming.header,
      model: config.visionFallbackModel,
      responsesToChat,
      reason: "vision-fallback"
    };
  }

  if (config.routeMode === "custom-vision" && multimodal) {
    if (multimodalPayload) {
      return {
        baseUrl: requireUrl(config.visionBackendBaseUrl, "VISION_BACKEND_BASE_URL"),
        apiKey: config.visionBackendApiKey || incomingKey,
        apiKeyHeader: incoming.header,
        model: config.visionBackendModel || specifiedModel,
        responsesToChat,
        reason: "custom-vision"
      };
    }
    return {
      baseUrl: config.defaultBackendBaseUrl,
      apiKey: incomingKey,
      apiKeyHeader: incoming.header,
      model: null,
      responsesToChat,
      reason: "passthrough-text-alias"
    };
  }

  return {
    baseUrl: config.defaultBackendBaseUrl,
    apiKey: incomingKey,
    apiKeyHeader: incoming.header,
    model: multimodal && multimodalPayload ? config.visionBackendModel : null,
    responsesToChat,
    reason: multimodal && multimodalPayload ? "default-multimodal" : "passthrough"
  };
}

export function buildUpstreamRequest({ originalPath, body, headers, route }) {
  const upstreamHeaders = new Headers(headers);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("content-length");
  upstreamHeaders.delete("connection");
  upstreamHeaders.delete("accept-encoding");

  if (route.apiKey && route.apiKeyHeader === "x-api-key") {
    upstreamHeaders.set("x-api-key", route.apiKey);
    upstreamHeaders.delete("authorization");
  } else if (route.apiKey) {
    upstreamHeaders.set("authorization", `Bearer ${route.apiKey}`);
    upstreamHeaders.delete("x-api-key");
  } else {
    upstreamHeaders.delete("authorization");
    upstreamHeaders.delete("x-api-key");
  }

  const nextBody = route.model ? { ...body, model: route.model } : body;
  const upstreamPath = route.responsesToChat && originalPath === "responses" ? "chat/completions" : originalPath;
  const upstreamBody = route.responsesToChat && originalPath === "responses"
    ? convertResponsesBodyToChat(nextBody)
    : nextBody;

  return {
    url: withV1Path(route.baseUrl, upstreamPath),
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody)
  };
}

export const internals = {
  getBearerToken,
  getIncomingApiKey,
  hasSpecifiedModel,
  hasMultimodalInput,
  hasCurrentUserMultimodalInput,
  isMultimodalModel,
  isVisionFallbackModel,
  isResponsesToChatModel,
  convertResponsesBodyToChat,
  withV1Path
};
