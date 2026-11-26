import { useEffect, useRef, useState } from "react";
import { Archive, ChevronLeft, ChevronRight, Undo2 } from "lucide-react";
import { marketDescription } from "./community-market-copy.js";

export function CommunityMarketMine({ owner, api, tr, language, kindLabels, describeError, refresh, locked, onBusy, onManaged }) {
  const [page,setPage]=useState(0),[result,setResult]=useState(null),[loading,setLoading]=useState(true);
  const [error,setError]=useState(""),[busy,setBusy]=useState("");
  const operation=useRef(false),mounted=useRef(false);
  const date = new Intl.DateTimeFormat(language,{dateStyle:"short",timeStyle:"short"});
  useEffect(()=>{ mounted.current=true; return ()=>{ mounted.current=false; }; },[]);
  useEffect(()=>{
    let active=true;
    setLoading(true);setError("");
    Promise.resolve().then(()=>api.mine({accountId:owner,page})).then(value=>{
      if(active)setResult(value);
    }).catch(failure=>{
      if(active){setResult(null);setError(describeError(failure,tr));}
    }).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[api,owner,page,refresh,describeError,tr]);

  async function manage(item,action) {
    if(operation.current||locked||loading)return;
    operation.current=true;setBusy(item.id);onBusy(true);setError("");
    try {
      const result=await api.manage({accountId:owner,id:item.id,revision:item.revision,action,
        ...(action==="unpublish"?{publishedRevision:item.publication.revision}:{})});
      if(result?.canceled||!mounted.current)return;
      if(!result?.changed)throw Error("COMMUNITY_MARKET_UNAVAILABLE");
      onManaged(action);
    } catch(failure) { if(mounted.current)setError(describeError(failure,tr)); }
    finally { operation.current=false;if(mounted.current)setBusy("");onBusy(false); }
  }

  function label(item) {
    if(item.publication?.visibility==="author_hidden")return tr("已下架","Unpublished");
    if(item.publication?.visibility==="moderator_hidden")return tr("管理员已下架","Removed by moderator");
    if(item.publication?.visibility==="published")return item.status==="pending"&&item.revision>item.publication.revision
      ? tr("已发布 · 新版待审核","Published · Update pending") : tr("已发布","Published");
    if(item.status==="pending")return tr("待审核","Pending review");
    if(item.status==="returned")return tr("已退回","Changes requested");
    if(item.status==="withdrawn")return tr("已撤回","Withdrawn");
    return tr("已通过审核","Approved");
  }

  return <section className="community-market-mine" aria-label={tr("我的投稿","My submissions")}>
    {loading && <p className="community-market-muted" role="status">{tr("正在读取你的投稿…","Loading your submissions…")}</p>}
    {error && <p className="community-market-error" role="alert">{error}</p>}
    {!loading&&!error&&result?.items.length===0&&<p className="community-market-muted">{tr("还没有投稿。","You haven't submitted anything yet.")}</p>}
    <div className="community-market-grid">
      {result?.items.map(item=>{
        const published=item.publication?.visibility==="published";
        const withdrawable=["pending","returned"].includes(item.status)&&(item.publication?.visibility!=="moderator_hidden");
        const description=marketDescription(item,tr);
        return <article key={item.id} className="community-market-card">
          <div className="community-market-meta"><span>{kindLabels[item.kind]} · r{item.revision}</span>
            <span className="community-market-count">{label(item)}</span>
          </div>
          <h4>{item.title}</h4>
          <p className="community-market-author">{item.createdAt&&date.format(new Date(item.createdAt))+" · "}#{item.id.slice(0,8)}</p>
          {description&&<p className="community-market-summary">{description}</p>}
          {(published||withdrawable)&&<div className="community-market-card-footer">
            <button type="button" className="community-market-action" disabled={loading||locked||Boolean(busy)}
              onClick={()=>void manage(item,published?"unpublish":"withdraw")}>
              {published?<Archive size={14} aria-hidden="true"/>:<Undo2 size={14} aria-hidden="true"/>}
              {busy===item.id?tr("处理中…","Working…"):published?tr("下架","Unpublish"):tr("撤回投稿","Withdraw submission")}
            </button>
          </div>}
        </article>;
      })}
    </div>
    {(page>0||result?.hasMore)&&<div className="community-market-toolbar-actions">
      <button type="button" className="community-market-action" disabled={page===0||loading||locked||Boolean(busy)} onClick={()=>setPage(n=>n-1)}>
        <ChevronLeft size={14} aria-hidden="true"/>{tr("上一页","Previous")}
      </button>
      <span className="community-market-muted">{page+1}</span>
      <button type="button" className="community-market-action" disabled={!result?.hasMore||loading||locked||Boolean(busy)} onClick={()=>setPage(n=>n+1)}>
        {tr("下一页","Next")}<ChevronRight size={14} aria-hidden="true"/>
      </button>
    </div>}
  </section>;
}
