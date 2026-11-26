const kinds = ['skill', 'mcp', 'agent', 'skin'];
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shaPattern = /^[a-f0-9]{64}$/;
const pageLimit = 100; // Keep a malfunctioning upstream from looping forever.

export function marketCount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function validVersion(id, sha256, revision) {
  return typeof id === 'string' && idPattern.test(id) && typeof sha256 === 'string' && shaPattern.test(sha256)
    && Number.isSafeInteger(revision) && revision > 0;
}

export function marketItem(row, kind) {
  if (row?.kind !== kind || !validVersion(row.id, row.sha256, row.revision) || typeof row.title !== 'string' || !row.title.trim()) {
    throw Error('COMMUNITY_CATALOG_INVALID');
  }
  return {
    id: row.id, sha256: row.sha256, revision: row.revision, kind, title: row.title.slice(0, 80),
    summary: typeof row.summary === 'string' ? row.summary.slice(0, 300) : '',
    author: typeof row.author_name === 'string' ? row.author_name.slice(0, 80) : '',
    publishedAt: Number.isFinite(Date.parse(row.published_at)) ? new Date(row.published_at).toISOString() : '',
    downloadAllowed: row.download_allowed === true, downloadCount: marketCount(row.download_count),
  };
}

export function marketSelection(input) {
  if (!input || Object.keys(input).some(key => !['accountId', 'id', 'sha256', 'revision', 'kind'].includes(key))
    || !kinds.includes(input.kind) || !validVersion(input.id, input.sha256, input.revision)) {
    throw Error('COMMUNITY_INVALID_REQUEST');
  }
  return input;
}

export function marketQuota(raw) {
  if (!Number.isSafeInteger(raw?.limit) || raw.limit < 1 || !Number.isSafeInteger(raw.remaining)
    || raw.remaining < 0 || raw.remaining > raw.limit || typeof raw.resetsAt !== 'string'
    || !Number.isFinite(Date.parse(raw.resetsAt))) return null;
  return { limit: raw.limit, remaining: raw.remaining, resetsAt: new Date(raw.resetsAt).toISOString() };
}

export function marketLocalResourceId(id) {
  return typeof id === 'string' && id.length <= 160 && kinds.some(kind => id.startsWith(kind + ':') && id.length > kind.length + 1);
}

export function marketSubmission(input) {
  if (!input || Object.keys(input).some(key => !['accountId','id','key','fingerprint','title','summary','consent','downloadAllowed'].includes(key))
    || !marketLocalResourceId(input.id) || typeof input.key !== 'string' || !idPattern.test(input.key)
    || typeof input.fingerprint !== 'string' || !shaPattern.test(input.fingerprint)
    || typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 80
    || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.trim().length > 300
    || input.consent !== true || typeof input.downloadAllowed !== 'boolean') throw Error('COMMUNITY_INVALID_UPLOAD');
  return { ...input, title: input.title.trim(), summary: input.summary.trim() };
}

const submissionStatuses = new Set(['pending','approved','returned','withdrawn']);
const publicationStatuses = new Set(['published','author_hidden','moderator_hidden']);
const validRevision = value => Number.isSafeInteger(value) && value > 0;

export function marketMySubmission(row, owner) {
  if (!row || row.owner_id !== owner || !idPattern.test(row.id) || !validRevision(row.revision)
    || !kinds.includes(row.kind) || !submissionStatuses.has(row.status) || typeof row.title !== 'string') {
    throw Error('COMMUNITY_CATALOG_INVALID');
  }
  const pub=row.publication;
  const publication=pub&&validRevision(pub.revision)&&publicationStatuses.has(pub.visibility)
    ? {revision:pub.revision,visibility:pub.visibility} : null;
  return {id:row.id,kind:row.kind,title:row.title.slice(0,80),summary:typeof row.summary==='string'?row.summary.slice(0,300):'',
    sha256:typeof row.sha256==='string'&&shaPattern.test(row.sha256)?row.sha256:'',
    createdAt:Number.isFinite(Date.parse(row.created_at))?new Date(row.created_at).toISOString():'',
    status:row.status,revision:row.revision,publication};
}

export function marketManageSelection(input) {
  if (!input || Object.keys(input).some(key=>!['accountId','id','action','revision','publishedRevision'].includes(key))
    || typeof input.id!=='string' || !idPattern.test(input.id) || !validRevision(input.revision)
    || (input.action==='unpublish' ? !validRevision(input.publishedRevision)
      : input.action!=='withdraw' || input.publishedRevision!==undefined)) throw Error('COMMUNITY_INVALID_REQUEST');
  return input;
}

export async function marketHasDuplicate(request, kind, sha256) {
  const scan=async(action,input)=>{
    for(let page=0;page<pageLimit;page++){
      const response=await request(action,{...input,page});
      if(!Array.isArray(response?.items)||typeof response.hasMore!=='boolean')throw Error('COMMUNITY_CATALOG_INVALID');
      if(response.items.some(row=>row.kind===kind&&row.sha256===sha256))return true;
      if(!response.hasMore)return false;
    }
    throw Error('COMMUNITY_CATALOG_TOO_LARGE');
  };
  const duplicates=await Promise.all([scan('marketMine',{}),scan('marketCatalog',{kind})]);
  return duplicates.some(Boolean);
}

export async function communityMarketCatalog(request) {
  const lists = await Promise.all(kinds.map(async kind => {
    const items = [];
    for (let page = 0; page < pageLimit; page++) {
      const result = await request('marketCatalog', { kind, page });
      if (!Array.isArray(result?.items) || typeof result.hasMore !== 'boolean') throw Error('COMMUNITY_CATALOG_INVALID');
      items.push(...result.items.map(row => marketItem(row, kind)));
      if (!result.hasMore) return items;
    }
    throw Error('COMMUNITY_CATALOG_TOO_LARGE');
  }));
  return [...new Map(lists.flat().map(item => [item.id, item])).values()];
}

export function communityMarketRequest(action, input) {
  if (action === 'marketRules') return { path: '/community/me' };
  if (action === 'marketCatalog' && kinds.includes(input?.kind) && Number.isInteger(input?.page)
    && input.page >= 0 && input.page < pageLimit && (input.id === undefined || idPattern.test(input.id))) {
    const query = new URLSearchParams({ kind: input.kind, page: String(input.page) });
    if (input.id) query.set('id', input.id);
    return { path: '/community/catalog?' + query };
  }
  if (action === 'marketImport' && validVersion(input?.id, input?.sha256, input?.revision)) {
    return { path: '/community/catalog/' + input.id + '/import', options: {
      method: 'POST', body: { sha256: input.sha256, revision: input.revision },
    } };
  }
  if (action === 'marketSubmit') {
    return { path: '/community/submissions', options: { method: 'POST', body: input, timeout: 30000 } };
  }
  if (action === 'marketMine' && Number.isInteger(input?.page) && input.page >= 0 && input.page < pageLimit) {
    return { path: '/community/submissions?page=' + input.page };
  }
  if (action === 'marketSubmissionDetail' && typeof input?.id === 'string' && idPattern.test(input.id)) {
    return { path: '/community/submissions/' + input.id };
  }
  if (action === 'marketManage') {
    const {id,action:operation,revision,publishedRevision}=marketManageSelection(input);
    return {path:'/community/submissions/'+id+'/'+operation,options:{method:'POST',body:{
      revision,...(operation==='unpublish'?{publishedRevision}:{}),
    }}};
  }
  return null;
}
