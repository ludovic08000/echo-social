export function computeMessageHash(prevHash, message){
  const data = prevHash + JSON.stringify(message);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash) + data.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString();
}

export function verifyChain(messages){
  let prev = '0';
  for(const m of messages){
    const h = computeMessageHash(prev, m);
    if(m.hash !== h) return false;
    prev = h;
  }
  return true;
}