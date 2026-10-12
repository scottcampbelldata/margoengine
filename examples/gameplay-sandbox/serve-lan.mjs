import {createServer as createViteServer} from 'vite';
import {createServer} from 'node:http';
import {networkInterfaces,homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';

const addresses=Object.values(networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)).map(a=>a.address);
if(!addresses.length)throw new Error('No private IPv4 network address found. Connect this PC to your LAN first.');
const host=addresses[0],directory=join(process.env.LOCALAPPDATA??homedir(),'MargoEngine','Afterlight'),keyPath=join(directory,'key.pem'),certPath=join(directory,'cert.pem');
mkdirSync(directory,{recursive:true});
let certificate;
if(existsSync(keyPath)&&existsSync(certPath))certificate=new X509Certificate(readFileSync(certPath));
if(!certificate||Date.parse(certificate.validTo)<Date.now()+86400000||!addresses.every(ip=>certificate.checkIP(ip))){
 const gitOpenSSL=join(process.env.ProgramFiles??'C:\\Program Files','Git','usr','bin','openssl.exe');
 const openssl=process.platform==='win32'&&existsSync(gitOpenSSL)?gitOpenSSL:'openssl';
 const generated=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','90','-subj','/CN=Afterlight LAN','-addext',`subjectAltName=DNS:localhost,IP:127.0.0.1,${addresses.map(ip=>`IP:${ip}`).join(',')}`,'-addext','basicConstraints=critical,CA:FALSE','-addext','extendedKeyUsage=serverAuth'],{encoding:'utf8'});
 if(generated.error||generated.status!==0)throw new Error(`Could not create the local HTTPS certificate: ${generated.error?.message??generated.stderr}`);
 certificate=new X509Certificate(readFileSync(certPath));
}
if(certificate.ca||!certificate.checkIP(host)||!certificate.verify(certificate.publicKey))throw new Error('Invalid Afterlight LAN certificate. Remove its cert.pem and key.pem files and restart.');
// Keep the private key outside Vite's workspace; only the public certificate is downloadable.
const publicCertificate=certificate.raw;
writeFileSync(join(directory,'afterlight.cer'),publicCertificate);
const server=await createViteServer({root:import.meta.dirname,configFile:resolve(import.meta.dirname,'vite.config.ts'),server:{host,port:5200,strictPort:true,https:{key:readFileSync(keyPath),cert:readFileSync(certPath)}}});
const download=createServer((request,response)=>{
 if(request.url!=='/afterlight.cer'){response.writeHead(404);response.end();return;}
 response.writeHead(200,{'Content-Type':'application/pkix-cert','Content-Disposition':'attachment; filename="afterlight.cer"'});response.end(publicCertificate);
});
try{
 await new Promise((ok,fail)=>{download.once('error',fail);download.listen(5201,host,ok);});
 await server.listen();
}catch(error){download.close();await server.close();throw error;}
console.log(`Afterlight: https://${host}:5200/\nPublic certificate: http://${host}:5201/afterlight.cer\nOn each Windows test PC, import that certificate into Current User > Trusted Root Certification Authorities.\nCertificate SHA-256: ${certificate.fingerprint256}`);
