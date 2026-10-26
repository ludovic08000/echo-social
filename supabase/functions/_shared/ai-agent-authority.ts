export async function ownsAgentConversation(db: any, userId: string, agentId: string, conversationId: string): Promise<boolean> {
  const { data, error } = await db.from("ai_agent_conversations").select("id")
    .eq("id", conversationId).eq("user_id", userId).eq("agent_id", agentId).maybeSingle();
  return !error && !!data;
}

export interface AgentUsageLease { commit(): Promise<void>; close(): Promise<void> }
export async function reserveAgentUsage(db: any, userId: string, agentId: string, headers: Record<string,string>):
  Promise<{denial: Response; lease?: never}|{denial?: never; lease: AgentUsageLease}> {
  const requestId=crypto.randomUUID();
  const {data,error}=await db.rpc("reserve_ai_agent_usage",{p_user_id:userId,p_agent_id:agentId,p_request_id:requestId});
  const unavailable=()=>new Response(JSON.stringify({error:"AI_USAGE_UNAVAILABLE"}),{
    status:503,headers:{...headers,"Content-Type":"application/json","Retry-After":"5"},
  });
  if(error||typeof data?.allowed!=="boolean")return {denial:unavailable()};
  if(!data.allowed)return {denial:new Response(JSON.stringify({error:"limit_reached",message:`Limite de ${data.limit} messages gratuits par jour atteinte.`}),{
    status:429,headers:{...headers,"Content-Type":"application/json"},
  })};
  let finished=false;
  async function finish(success:boolean){
    if(finished)return;
    const {data:confirmed,error:finishError}=await db.rpc("finish_ai_agent_usage",{p_request_id:requestId,p_success:success});
    if(finishError||confirmed!==true)throw new Error("AI_USAGE_SETTLEMENT_UNCONFIRMED");
    finished=true;
  }
  return {lease:{commit:()=>finish(true),close:()=>finish(false)}};
}
