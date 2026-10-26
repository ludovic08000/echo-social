import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export async function decideMessageRequest(req: Request, body: any, cors: Record<string,string>): Promise<Response> {
  const respond=(status:number,payload:Record<string,unknown>)=>new Response(JSON.stringify(payload),{
    status,headers:{...cors,"Content-Type":"application/json"},
  });
  if (body.action === "moderate_message") return respond(410,{error:"E2EE_MESSAGE_CONTENT_UNAVAILABLE",safe:null});
  if (!["accept_request","reject_request"].includes(body.action)) return respond(400,{error:"INVALID_ACTION"});
  if (typeof body.conversationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(body.conversationId)) {
    return respond(400,{error:"INVALID_CONVERSATION"});
  }
  const client=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{
    global:{headers:{Authorization:req.headers.get("authorization")||""}},
  });
  const {data,error}=await client.rpc("decide_direct_message_request",{
    p_conversation_id:body.conversationId,p_accept:body.action==="accept_request",
  });
  if(error) return respond(error.code==="42501"?403:500,{error:error.code==="42501"?"FORBIDDEN":"INTERNAL"});
  return respond(200,body.action==="accept_request"?{accepted:true,changed:data}:{rejected:true,changed:data});
}
