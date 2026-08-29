import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("context", async (_event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;

    let changed = false;
    const messages = _event.messages.map((m) => {
      if (m.role !== "assistant") return m;
      // 已是当前条目产生的消息，无需处理
      if (m.provider === model.provider) return m;
      // 模型 ID 相同（且走同一套线协议）才视为同一模型；
      // 真正不同的模型保持默认行为（由 pi 决定降级方式）
      if (m.model !== model.id || m.api !== model.api) return m;

      // 仅改写 provider：让 transformMessages 的 isSameModel 判定为同模型，
      // 思维块原样回放并在序列化时写入 reasoning_content 字段。
      // 此处操作的是本次请求的深拷贝，session 文件不受影响。
      changed = true;
      return { ...m, provider: model.provider };
    });

    return changed ? { messages } : undefined;
  });
}
