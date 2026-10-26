// Une souscription utilisateur n'autorise pas le serveur à contacter un hôte arbitraire.
export function allowedPushEndpoint(value: string): URL | null {
  try {
    const url=new URL(value);
    if(url.protocol!=="https:" || url.username || url.password || url.hash || (url.port && url.port!=="443")) return null;
    const host=url.hostname.toLowerCase();
    const exact=new Set(["fcm.googleapis.com","android.googleapis.com","updates.push.services.mozilla.com"]);
    const trusted=exact.has(host) || /^(?:[a-z0-9-]+\.)*push\.apple\.com$/.test(host)
      || /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/.test(host);
    return trusted?url:null;
  }catch{return null;}
}
