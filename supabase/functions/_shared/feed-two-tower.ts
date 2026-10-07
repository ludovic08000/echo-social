import { SIGNAL_LABEL } from './feed-training-policy.ts';
export interface TrainingEvent { user_id: string; post_id: string; signal_type: string; created_at: string }
const DIM = 256;
function seed(text: string) {
  let n=2166136261;
  for (const c of text) n=Math.imul(n ^ c.charCodeAt(0),16777619);
  return () => { n=Math.imul(n,1664525)+1013904223|0; return (n>>>0)/4294967296; };
}
function normalize(v: number[]) { const norm=Math.hypot(...v)||1; return v.map(x=>x/norm); }
function vector(key: string) { const random=seed(key); return normalize(Array.from({length:DIM},()=>random()-.5)); }
function dot(a: number[],b: number[]) { return a.reduce((sum,x,i)=>sum+x*b[i],0); }

/** Offline candidate only. Pair-disjoint, chronological holdout; no live writes. */
export function trainFeedCandidate(events: TrainingEvent[]) {
  const pairs = new Map<string, { user:string; post:string; label:number; time:number; count:number }>();
  for (const e of events) {
    const label=SIGNAL_LABEL[e.signal_type], time=Date.parse(e.created_at);
    if (label===undefined || !Number.isFinite(time)) continue;
    const key=e.user_id+':'+e.post_id, old=pairs.get(key);
    pairs.set(key,{user:e.user_id,post:e.post_id,label:(old?.label??0)+label,
      count:(old?.count??0)+1,time:Math.max(old?.time??0,time)});
  }
  const rows=[...pairs.values()].sort((a,b)=>a.time-b.time || a.user.localeCompare(b.user) || a.post.localeCompare(b.post))
    .map(r=>({...r,label:r.label/r.count}));
  const split=Math.floor(rows.length*.8), train=rows.slice(0,split), holdout=rows.slice(split);
  const users=new Map<string,number[]>(), posts=new Map<string,number[]>();
  for(const r of train) { if(!users.has(r.user))users.set(r.user,vector('u:'+r.user)); if(!posts.has(r.post))posts.set(r.post,vector('p:'+r.post)); }
  const known=holdout.filter(r=>users.has(r.user)&&posts.has(r.post));
  const loss=()=>known.length ? known.reduce((sum,r)=>sum+(dot(users.get(r.user)!,posts.get(r.post)!)-r.label)**2,0)/known.length : null;
  const baseline=loss(), random=seed('feed-candidate');
  for(let epoch=0;epoch<2;epoch++){
    const order=[...train];
    for(let i=order.length-1;i>0;i--){const j=Math.floor(random()*(i+1)); [order[i],order[j]]=[order[j],order[i]];}
    for(const r of order){
      const u=users.get(r.user)!, p=posts.get(r.post)!, error=dot(u,p)-r.label;
      const nextU=u.map((x,i)=>x-.05*error*p[i]), nextP=p.map((x,i)=>x-.05*error*u[i]);
      users.set(r.user,normalize(nextU)); posts.set(r.post,normalize(nextP));
    }
  }
  const validation=loss();
  return {
    metrics: {
      train_pairs:train.length, holdout_pairs:holdout.length, evaluated_pairs:known.length,
      evaluated_users:new Set(known.map(r=>r.user)).size,
      holdout_coverage:holdout.length ? known.length/holdout.length : 0,
      baseline_mse:baseline, validation_mse:validation, dimension:DIM,
      offline_gate:known.length>=100 && new Set(known.map(r=>r.user)).size>=20
        && known.length/Math.max(1,holdout.length)>=.9 && validation!==null && baseline!==null && validation<baseline,
      production_order_changed:false,
    },
    artifacts: { users:[...users].map(([id,embedding])=>({id,embedding})),
      posts:[...posts].map(([id,embedding])=>({id,embedding})) },
  };
}
