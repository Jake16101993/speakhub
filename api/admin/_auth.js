import crypto from 'node:crypto';

export function signAdminToken(){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;
  if(!secret) throw new Error('ADMIN_SECRET_MISSING');
  const payload=Buffer.from(JSON.stringify({exp:Date.now()+8*60*60*1000})).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function requireAdmin(request){
  const secret=process.env.SPEAKHUB_ADMIN_SECRET;
  if(!secret) return false;
  const auth=request.headers.get('authorization')||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const [payload,sig]=token.split('.');
  if(!payload||!sig) return false;
  const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  if(sig.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return false;
  try{
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    return Number(data.exp)>Date.now();
  }catch{return false}
}
