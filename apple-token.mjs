import { createPrivateKey, sign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export function signAppleToken({privateKey,teamId,keyId,origin,now=Math.floor(Date.now()/1000)}) {
  if(!/^[A-Za-z0-9]{10}$/.test(teamId||'')||!/^[A-Za-z0-9]{10}$/.test(keyId||''))throw new Error('Apple Team ID 和 Key ID 必须各为 10 位字母或数字。');
  let url;try{url=new URL(origin);}catch{}
  if(!url||url.origin!==origin||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port)throw new Error('Apple 令牌只签发给当前本机地址。');
  let key;try{key=createPrivateKey(privateKey);}catch{throw new Error('无法读取 Apple MusicKit 私钥。');}
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new Error('MusicKit 私钥必须使用 P-256 曲线。');
  const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const data=encoded({alg:'ES256',kid:keyId})+'.'+encoded({iss:teamId,iat:now,exp:now+3600,origin:[origin]});
  const signature=sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return data+'.'+signature;
}

// Reads an explicitly configured local key. Never uploads it, writes a JWT, or logs secrets.
export async function appleTokenFromEnvironment(env,origin) {
  if(env.APPLE_MUSIC_DEVELOPER_TOKEN)return env.APPLE_MUSIC_DEVELOPER_TOKEN;
  if(!env.APPLE_MUSIC_KEY_FILE)return '';
  const file=env.APPLE_MUSIC_KEY_FILE;
  if(!isAbsolute(file)||!file.toLowerCase().endsWith('.p8'))throw new Error('APPLE_MUSIC_KEY_FILE 必须是本机 .p8 文件的绝对路径。');
  let pem;
  try{const info=await stat(file);if(!info.isFile()||info.size>16384)throw new Error();pem=await readFile(file,'utf8');}
  catch{throw new Error('无法读取指定的 MusicKit .p8 文件。请检查路径和文件大小，不要上传私钥。');}
  return signAppleToken({privateKey:pem,teamId:env.APPLE_MUSIC_TEAM_ID,keyId:env.APPLE_MUSIC_KEY_ID,origin});
}
