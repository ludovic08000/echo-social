interface OutgoingCallOperations {
  conversationId:string;callerId:string;recipientId:string;type:'audio'|'video';
  createKey:()=>string;
  signal:(conversationId:string,callerId:string,recipientId:string,type:'audio'|'video',key:string)=>Promise<string|null>;
  start:(id:string,type:'audio'|'video',key:string)=>Promise<boolean>;
  end:(id:string)=>Promise<unknown>;
  active:(id:string|null)=>void;
  cancelled?:()=>boolean;
}
/** Shares the normal call path; never returns the media key to the assistant. */
export async function launchOutgoingCall(operations:OutgoingCallOperations):Promise<boolean>{
  if(operations.cancelled?.())return false;
  const key=operations.createKey();
  const id=await operations.signal(operations.conversationId,operations.callerId,operations.recipientId,operations.type,key);
  if(!id)throw new Error('Le serveur n’a pas confirmé la création de l’appel.');
  if(operations.cancelled?.()){await operations.end(id).catch(()=>undefined);return false;}
  operations.active(id);
  try{
    const started=await operations.start(id,operations.type,key);
    if(!started){operations.active(null);await operations.end(id).catch(()=>undefined);}
    return started;
  }catch(error){operations.active(null);await operations.end(id).catch(()=>undefined);throw error;}
}
