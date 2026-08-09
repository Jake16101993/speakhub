import { signAdminToken } from './_auth.js';
export default {
  async fetch(request){
    if(request.method!=='POST') return Response.json({error:'Method not allowed'},{status:405});
    const body=await request.json().catch(()=>({}));
    const expected=process.env.SPEAKHUB_ADMIN_PASSWORD;
    if(!expected) return Response.json({error:'ADMIN_PASSWORD_MISSING'},{status:500});
    if(String(body.password||'')!==expected) return Response.json({error:'INVALID_PASSWORD'},{status:401});
    return Response.json({token:signAdminToken()});
  }
};
