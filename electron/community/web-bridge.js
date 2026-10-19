import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';

export const COMMUNITY_BRIDGE_PORT=47431;
export const COMMUNITY_BRIDGE_PROTOCOL='aporiax-community-local-v1';

// Fixed loopback surface: no arbitrary URLs, paths, content, commands or token
// proxy. Only the configured website may detect counts or request a confirmed
// private sync using the desktop's own authenticated account.
export async function startCommunityWebBridge({repository,allowedOrigins,port=COMMUNITY_BRIDGE_PORT}){
  const origins=new Set(allowedOrigins),challenges=new Map();let working=false;
  const server=createServer(async(req,res)=>{
    const origin=req.headers.origin,expectedHost='127.0.0.1:'+server.address()?.port;
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    if(req.headers.host!==expectedHost||!origins.has(origin))return reply(403,{error:'COMMUNITY_ORIGIN_DENIED'});
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');
    if(req.method==='OPTIONS'){
      const method=req.headers['access-control-request-method'];
      if(!(method==='GET'&&req.url==='/v1/status'||method==='POST'&&['/v1/detect','/v1/sync','/v1/received','/v1/pull'].includes(req.url)))return reply(405,{error:'COMMUNITY_METHOD_DENIED'});
      res.setHeader('Access-Control-Allow-Methods','GET, POST');res.setHeader('Access-Control-Allow-Headers','Content-Type, X-Aporia-Community-Challenge');
      if(req.headers['access-control-request-private-network']==='true')res.setHeader('Access-Control-Allow-Private-Network','true');
      return reply(204,{});
    }
    if(req.method==='GET'&&req.url==='/v1/status'){
      for(const [key,ticket] of challenges)if(ticket.expires<Date.now())challenges.delete(key);
      if(challenges.size>=32)challenges.delete(challenges.keys().next().value);
      const challenge=randomBytes(32).toString('hex');challenges.set(challenge,{origin,expires:Date.now()+300000});
      return reply(200,{protocol:COMMUNITY_BRIDGE_PROTOCOL,challenge,capabilities:typeof repository.pull==='function'?['repository-receive-v1']:[]});
    }
    if(req.method!=='POST'||!['/v1/detect','/v1/sync','/v1/received','/v1/pull'].includes(req.url))return reply(404,{error:'COMMUNITY_ENDPOINT_DENIED'});
    const challenge=req.headers['x-aporia-community-challenge'],ticket=challenges.get(challenge);
    if(!ticket||ticket.expires<Date.now()||ticket.origin!==origin)return reply(403,{error:'COMMUNITY_CHALLENGE_INVALID'});
    if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'COMMUNITY_JSON_REQUIRED'});
    if(working)return reply(409,{error:'COMMUNITY_SYNC_BUSY'});
    working=true;
    try{
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>2048)return reply(413,{error:'COMMUNITY_INVALID_REQUEST'});chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return reply(400,{error:'COMMUNITY_INVALID_REQUEST'});}
      const pull=req.url==='/v1/pull',allowed=pull?['accountId','apiBaseUrl','id','sha256','revision']:['accountId','apiBaseUrl'];
      if(!input||Object.keys(input).length!==allowed.length||Object.keys(input).some(key=>!allowed.includes(key))||typeof input.accountId!=='string'||input.accountId.length>100||typeof input.apiBaseUrl!=='string'||input.apiBaseUrl.length>500||pull&&(!/^[a-f0-9-]{36}$/i.test(input.id)||!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isInteger(input.revision)||input.revision<1))return reply(400,{error:'COMMUNITY_INVALID_REQUEST'});
      if(req.url==='/v1/sync'||pull)challenges.delete(challenge); // One-time write ticket.
      const result=req.url==='/v1/detect'?await repository.detectAll(input):req.url==='/v1/received'?await repository.received(input):pull?await repository.pull(input):await repository.syncAll(input);
      return reply(200,result);
    }catch(error){
      const code=String(error.message).split(':')[0];
      // Never return file paths, parser details or raw resource data.
      return reply(409,{error:/^(?:COMMUNITY_[A-Z_]+|DESKTOP_ACCOUNT_SIGNED_OUT)$/.test(code)?code:'COMMUNITY_LOCAL_READ_FAILED'});
    }finally{working=false;}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {port:server.address().port,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
