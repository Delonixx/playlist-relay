'use strict';
const [authLocalToken,authNonce]=location.hash.slice(1).split(':');
const authStatus=document.getElementById('auth-status'),authButton=document.getElementById('btn-authorize');
history.replaceState(null,'','/apple-auth.html');
async function authAPI(path,data={}){
  const response=await fetch('/api/'+path,{method:'POST',signal:AbortSignal.timeout(25000),headers:{'Content-Type':'application/json','X-Local-Token':authLocalToken},body:JSON.stringify({expectedPlatform:'apple',nonce:authNonce,...data})});
  const value=await response.json();if(!response.ok)throw new Error(value.error||'本地授权未完成。');return value;
}
let authInstance;
async function prepareApple(){
  if(!/^[a-f0-9]{64}$/.test(authLocalToken||'')||!/^[a-f0-9]{64}$/.test(authNonce||''))throw new Error('授权入口不完整。请从主页面重新生成。');
  const config=await authAPI('apple/auth-config');
  await new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://js-cdn.music.apple.com/musickit/v3/musickit.js';
    const timer=setTimeout(()=>{script.remove();reject(new Error('Apple 官方授权组件加载超时。请检查网络，再从主页面重新打开授权。'));},20000);
    script.addEventListener('load',()=>{clearTimeout(timer);resolve();},{once:true});script.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Apple 官方授权组件未加载。请检查网络，勿粘贴账号密码。'));},{once:true});document.head.append(script);
  });
  if(!window.MusicKit)throw new Error('Apple 官方授权组件未初始化。');
  await window.MusicKit.configure({developerToken:config.developerToken,app:{name:'歌单接力',build:'0.7.0'},suppressErrorDialog:true});
  authInstance=window.MusicKit.getInstance();authButton.disabled=false;authStatus.textContent='准备好了。点击下方按钮，在 Apple 官方页面完成授权。';
}
authButton.addEventListener('click',async()=>{
  authButton.disabled=true;authStatus.textContent='请在 Apple 官方窗口完成授权…';
  try{
    let token;try{token=await authInstance.authorize();}catch{throw new Error('Apple 授权未完成或已取消。请返回主页面重新生成授权入口。');}
    const result=await authAPI('apple/user-token',{userToken:token});token='';
    if(!result.user)throw new Error('用户资料库尚未验证。');
    authStatus.textContent='Apple Music 已连接。返回主页面，点击“检查连接”后选择资料库歌单。';
    const link=document.getElementById('auth-return');link.href='/#'+authLocalToken;link.classList.remove('hidden');
  }catch(error){authStatus.textContent=error.message;}
});
prepareApple().catch(error=>{authStatus.textContent=error.message;});
