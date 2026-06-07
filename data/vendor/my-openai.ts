/**
 * Toonflow OpenAI GPT provider
 * @version 1.0
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "my-openai",
  version: "2.0",
  author: "青蛙王子",
  name: "OpenAI GPT",
  description: "OpenAI GPT 文本与 gpt-image-2 图片供应商，图片通过 Responses 任务轮询获取最终结果。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "https://api.openai.com/v1" },
    { key: "responsesModel", label: "图片Responses模型", type: "text", required: true, placeholder: "gpt-5.5" },
    { key: "compatibilityMode", label: "兼容模式", type: "text", required: true, placeholder: "关闭 / 开启" },
  ],
  inputValues: {
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    responsesModel: "gpt-5.5",
    compatibilityMode: "关闭",
  },
  models: [
    { name: "GPT-5.5", modelName: "gpt-5.5", type: "text", think: true },
    { name: "GPT-5.4", modelName: "gpt-5.4", type: "text", think: true },
    { name: "GPT-image-2", type: "image", modelName: "gpt-image-2", mode: ["text", "singleImage", "multiReference"] },
    { name: "GPT-image-2-all(仅支持1K)", type: "image", modelName: "gpt-image-2-all", mode: ["text", "singleImage", "multiReference"] },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const getBaseUrl = () => (vendor.inputValues.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

const getAuthorization = () => {
  const apiKey = vendor.inputValues.apiKey;
  if (!apiKey) throw new Error("缺少API Key");
  return apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;
};

const parseJsonResponse = async (response: any) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`接口返回了非 JSON 内容: ${text}`);
  }
};

const throwIfNotOk = async (response: any, action: string) => {
  if (response.ok) return;
  const errorText = await response.text();
  throw new Error(`${action}失败: ${response.status}, ${errorText}`);
};

const normalizeDataUrl = (base64: string) => {
  if (/^data:[^;]+;base64,/.test(base64)) return base64;
  return `data:image/png;base64,${base64}`;
};

const isCompatibilityMode = () => {
  const value = String(vendor.inputValues.compatibilityMode || "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "enabled", "enable", "开启", "打开", "兼容", "兼容模式"].includes(value);
};

const getGptImageSize = (imageConfig: ImageConfig, modelName: string) => {
  const normalizedAspectRatio = imageConfig.aspectRatio === "9:16" ? "9:16" : imageConfig.aspectRatio === "16:9" ? "16:9" : "1:1";
  if (modelName === "gpt-image-2-all") {
    const oneKMap: Record<string, string> = {
      "1:1": "1024x1024",
      "16:9": "1536x1024",
      "9:16": "1024x1536",
    };
    return oneKMap[normalizedAspectRatio];
  }
  const sizeMap: Record<string, Record<string, string>> = {
    "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "3840x3840" },
    "16:9": { "1K": "1536x1024", "2K": "2048x1152", "4K": "3840x2160" },
    "9:16": { "1K": "1024x1536", "2K": "1152x2048", "4K": "2160x3840" },
  };
  return sizeMap[normalizedAspectRatio]?.[imageConfig.size] || sizeMap["1:1"]["1K"];
};

const getImageQuality = (size: ImageConfig["size"]) => {
  const qualityMap: Record<ImageConfig["size"], string> = {
    "1K": "low",
    "2K": "medium",
    "4K": "high",
  };
  return qualityMap[size] || "medium";
};

const extractImageResult = (data: any) => {
  const response = data?.response || data;
  const output = response?.output || data?.output || [];
  logger(`[imageRequest] 响应输出项数量: ${Array.isArray(output) ? output.length : 0}`);
  for (const item of output) {
    logger(`[imageRequest] 响应输出项类型: ${item?.type || "unknown"}`);
    if (item?.type === "image_generation_call" && typeof item?.result === "string" && item.result.length > 0) {
      const outputFormat = item.output_format || "png";
      logger(`[imageRequest] 提取到图片结果，格式: ${outputFormat}, base64长度: ${item.result.length}`);
      return `data:image/${outputFormat};base64,${item.result}`;
    }
  }
  return undefined;
};

const getResponseStatus = (data: any) => String(data?.response?.status || data?.status || "").toLowerCase();

const getResponseError = (data: any) => {
  const error = data?.response?.error || data?.error;
  if (!error) return "";
  return error.message || JSON.stringify(error);
};

const extractImageUrlOrBase64 = (data: any) => {
  const candidates = [
    data?.data?.[0]?.b64_json,
    data?.data?.[0]?.url,
    data?.data?.b64_json,
    data?.data?.url,
    data?.b64_json,
    data?.url,
    data?.image,
    data?.result,
  ];
  return candidates.find((item) => typeof item === "string" && item.length > 0);
};

const normalizeImageResult = async (result: string) => {
  if (/^https?:\/\//i.test(result)) return await urlToBase64(result);
  return normalizeDataUrl(result);
};

const imageGenerationsRequest = async (config: ImageConfig, model: ImageModel, resolvedSize: string, resolvedQuality: string) => {
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    n: 1,
    size: resolvedSize,
    quality: resolvedQuality,
    background: "auto",
    output_format: "png",
    response_format: "b64_json",
  };
  logger(
    `[imageRequest] 兼容模式: 使用 /images/generations, model=${model.modelName}, size=${resolvedSize}, quality=${resolvedQuality}, promptLength=${config.prompt.length}`,
  );
  const response = await fetch(`${getBaseUrl()}/images/generations`, {
    method: "POST",
    headers: { Authorization: getAuthorization(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwIfNotOk(response, "兼容模式图片生成");
  const data = await parseJsonResponse(response);
  const result = extractImageUrlOrBase64(data);
  if (!result) throw new Error(`${model.modelName} 兼容模式图片生成成功但未返回可用结果: ${JSON.stringify(data)}`);
  const normalized = await normalizeImageResult(result);
  logger(`[imageRequest] 兼容模式图片生成完成，dataUrlLength=${normalized.length}`);
  return normalized;
};

const imageEditsRequest = async (
  config: ImageConfig,
  model: ImageModel,
  resolvedSize: string,
  resolvedQuality: string,
  references: Extract<ReferenceList, { type: "image" }>[],
) => {
  const images = references.map((reference, index) => {
    logger(`[imageRequest] 兼容模式: 添加 edits 参考图 index=${index}, base64Length=${reference.base64.length}`);
    return { image_url: normalizeDataUrl(reference.base64) };
  });
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    images,
    size: resolvedSize,
    quality: resolvedQuality,
    background: "auto",
    output_format: "png",
    response_format: "b64_json",
  };
  logger(
    `[imageRequest] 兼容模式: 使用 /images/edits(JSON data URL), model=${model.modelName}, size=${resolvedSize}, quality=${resolvedQuality}, referenceCount=${references.length}, promptLength=${config.prompt.length}`,
  );
  const response = await fetch(`${getBaseUrl()}/images/edits`, {
    method: "POST",
    headers: { Authorization: getAuthorization(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await throwIfNotOk(response, "兼容模式图片编辑");
  const data = await parseJsonResponse(response);
  const result = extractImageUrlOrBase64(data);
  if (!result) throw new Error(`${model.modelName} 兼容模式图片编辑成功但未返回可用结果: ${JSON.stringify(data)}`);
  const normalized = await normalizeImageResult(result);
  logger(`[imageRequest] 兼容模式图片编辑完成，dataUrlLength=${normalized.length}`);
  return normalized;
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  const apiKey = getAuthorization().replace(/^Bearer\s+/i, "");
  const extraBody: Record<string, any> = {};
  if (model.think && think && thinkLevel > 0) {
    const effortMap: Record<0 | 1 | 2 | 3, "low" | "low" | "medium" | "high"> = {
      0: "low",
      1: "low",
      2: "medium",
      3: "high",
    };
    extraBody.reasoning_effort = effortMap[thinkLevel];
  }
  return createOpenAI({ baseURL: getBaseUrl(), apiKey, extraBody }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  if (!model.modelName.startsWith("gpt-image-")) throw new Error(`不支持的图片模型: ${model.modelName}`);

  const references = config.referenceList ?? [];
  const referenceCount = references.length;
  const resolvedSize = getGptImageSize(config, model.modelName);
  const resolvedQuality = getImageQuality(config.size);
  logger(
    `[imageRequest] 参数: imageModel=${model.modelName}, imageMode=${isCompatibilityMode() ? "兼容模式" : "responses"}, responsesModel=${vendor.inputValues.responsesModel || "gpt-5.5"}, size=${resolvedSize}, quality=${resolvedQuality}, aspectRatio=${config.aspectRatio}, referenceCount=${referenceCount}, promptLength=${config.prompt.length}`,
  );

  if (isCompatibilityMode()) {
    return referenceCount > 0
      ? imageEditsRequest(config, model, resolvedSize, resolvedQuality, references)
      : imageGenerationsRequest(config, model, resolvedSize, resolvedQuality);
  }

  const content: any[] = [{ type: "input_text", text: config.prompt }];
  for (const [index, reference] of references.entries()) {
    logger(`[imageRequest] 添加参考图: index=${index}, base64Length=${reference.base64?.length ?? 0}`);
    content.push({ type: "input_image", image_url: normalizeDataUrl(reference.base64) });
  }

  const body: Record<string, any> = {
    model: vendor.inputValues.responsesModel || "gpt-5.5",
    background: true,
    stream: false,
    store: true,
    tool_choice: "auto",
    input: [
      {
        role: "user",
        content,
      },
    ],
    tools: [
      {
        type: "image_generation",
        model: model.modelName,
        size: resolvedSize,
        quality: resolvedQuality,
        output_format: "png",
        background: "auto",
      },
    ],
  };

  logger(`[imageRequest] 创建 Responses 图片任务，模型是: ${model.modelName}`);
  const url = `${getBaseUrl()}/responses`;
  const data = {
    method: "POST",
    headers: { Authorization: getAuthorization(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  logger(`[imageRequest] Responses请求摘要: url=${url}, method=POST, bodyLength=${data.body.length}`);
  const createResponse = await fetch(url, data);
  await throwIfNotOk(createResponse, "Responses图片任务创建");

  const createData = await parseJsonResponse(createResponse);
  logger(
    `[imageRequest] Responses创建返回: id=${createData?.id || createData?.response?.id || "none"}, status=${getResponseStatus(createData) || "unknown"}`,
  );
  const immediateResult = extractImageResult(createData);
  if (immediateResult) {
    logger(`[imageRequest] 创建响应已包含图片结果，dataUrlLength=${immediateResult.length}`);
    return immediateResult;
  }

  const responseId = createData?.id || createData?.response?.id;
  if (!responseId) throw new Error(`Responses图片任务创建成功但未返回 response id: ${JSON.stringify(createData)}`);

  logger(`[imageRequest] Responses任务ID: ${responseId}`);
  let pollCount = 0;
  const result = await pollTask(async () => {
    pollCount++;
    logger(`[imageRequest] 第${pollCount}次查询Responses任务: ${responseId}`);
    const queryResponse = await fetch(`${getBaseUrl()}/responses/${encodeURIComponent(responseId)}`, {
      method: "GET",
      headers: { Authorization: getAuthorization() },
    });
    await throwIfNotOk(queryResponse, "Responses图片任务查询");

    const queryData = await parseJsonResponse(queryResponse);
    const imageResult = extractImageResult(queryData);
    if (imageResult) {
      logger(`[imageRequest] Responses任务生成完成，轮询次数: ${pollCount}, dataUrlLength=${imageResult.length}`);
      return { completed: true, data: imageResult };
    }

    const status = getResponseStatus(queryData);
    if (status === "failed" || status === "cancelled" || status === "canceled" || status === "incomplete") {
      const errorMessage = getResponseError(queryData) || `${model.modelName} 图片任务失败: ${JSON.stringify(queryData)}`;
      logger(`[imageRequest] Responses任务失败，状态: ${status}, 错误: ${errorMessage}`);
      return { completed: true, error: errorMessage };
    }
    if (status === "completed") {
      logger(`[imageRequest] Responses任务状态已完成但未找到图片结果`);
      return { completed: true, error: `${model.modelName} 图片任务已完成但没有返回 image_generation_call.result: ${JSON.stringify(queryData)}` };
    }

    logger(`[imageRequest] Responses任务轮询中，状态: ${status || "unknown"}`);
    return { completed: false };
  }, 5000, 1800000);

  if (result.error) throw new Error(result.error);
  if (!result.data) throw new Error(`${model.modelName} 图片任务轮询结束但没有返回图片结果`);
  logger(`[imageRequest] 返回图片结果，dataUrlLength=${result.data.length}`);
  return result.data;
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: vendor.version, notice: "## 当前已是最新版本" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export { };
