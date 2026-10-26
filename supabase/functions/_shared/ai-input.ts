export function userChatHistory(input: unknown): {role:"user"|"assistant";content:string}[] {
  if(!Array.isArray(input) || input.length>40)throw new Error("INVALID_CHAT_HISTORY");
  return input.map(message=>{
    if(!message || !["user","assistant"].includes(message.role)
      || typeof message.content!=="string" || message.content.length>10000)throw new Error("INVALID_CHAT_HISTORY");
    return {role:message.role,content:message.content};
  });
}
