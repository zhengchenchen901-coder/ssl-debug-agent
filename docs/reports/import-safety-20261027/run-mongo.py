from pathlib import Path
import subprocess,json,uuid,time
root=Path('/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-safety')
receipt=json.loads((root/'testflow-freeze.json').read_text());fixed=root/'.testflow/snapshots'/receipt['target']['contentHash']/'files'
suffix=uuid.uuid4().hex[:12];network='rda-import-risk-net-'+suffix;mongo='rda-import-risk-db-'+suffix;helper='rda-import-risk-'+suffix
image=(Path('/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-risk')/'dependencies/mongo-image-id.txt').read_text().strip();driver=Path('/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-bulk-driver/dependencies/node_modules')
config=root/'isolated-mongo-config.json';config.write_text(json.dumps({'test':{'url':'mongodb://mongo:27017/test?replicaSet=fixture'}}));config.chmod(0o600)
created=[];result={'snapshotId':receipt['snapshotId'],'nativeOwnerDialog':'mocked','realMongo':True,'helperImage':image,'databaseImage':'sha256:9ef36ccfdfb42c68dbc7757af3d1e732eaca253ed0cc529a6dd4d728ea97fd44','network':'internal, no published ports','container':helper,'cleaned':False}
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()
try:
 run(['docker','network','create','--internal',network]);created.append(('network',network))
 run(['docker','run','-d','--name',mongo,'--network',network,'--network-alias','mongo','--tmpfs','/data/db:size=512m','sha256:9ef36ccfdfb42c68dbc7757af3d1e732eaca253ed0cc529a6dd4d728ea97fd44','--replSet','fixture','--bind_ip_all']);created.append(('container',mongo))
 deadline=time.time()+50
 while True:
  p=subprocess.run(['docker','exec',mongo,'mongo','--quiet','--eval','db.runCommand({ping:1}).ok'],capture_output=True,text=True)
  if p.returncode==0:break
  if time.time()>deadline:raise RuntimeError('isolated Mongo startup timeout')
  time.sleep(0.5)
 run(['docker','exec',mongo,'mongo','--quiet','--eval',"rs.initiate({_id:'fixture',members:[{_id:0,host:'mongo:27017'}]})"])
 while True:
  p=subprocess.run(['docker','exec',mongo,'mongo','--quiet','--eval','db.isMaster().ismaster'],capture_output=True,text=True)
  if p.returncode==0 and p.stdout.strip()=='true':break
  if time.time()>deadline:raise RuntimeError('isolated primary timeout')
  time.sleep(0.5)
 run(['docker','run','-d','--name',helper,'--network',network,'--read-only','--tmpfs','/tmp:exec,size=256m','-v',str(config)+':/home/app/config.json:ro',image,'node','-e','setInterval(()=>{},60000)']);created.append(('container',helper))
 import os
 env=dict(os.environ);env['RDA_IMPORT_TEST_CONTAINER']=helper
 with (root/'mongo-integration.tap').open('w') as out:
  p=subprocess.run(['/Users/zhengchenchen/.nvm/versions/node/v22.23.3/bin/node','--test',str(fixed/'agent/test/import-risk-mongo.e2e.mjs')],env=env,stdout=out,stderr=subprocess.STDOUT)
 result['exitCode']=p.returncode
 print('mongo integration exit:',p.returncode)
finally:
 cleanup=[]
 for kind,name in reversed(created):
  p=subprocess.run(['docker',kind,'rm']+(['-f'] if kind=='container' else [])+[name],capture_output=True,text=True);cleanup.append({'type':kind,'name':name,'exitCode':p.returncode})
 result['cleanup']=cleanup;result['cleaned']=all(x['exitCode']==0 for x in cleanup)
 (root/'mongo-integration-result.json').write_text(json.dumps(result,indent=2))
