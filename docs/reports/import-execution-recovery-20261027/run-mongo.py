from pathlib import Path
import subprocess,json,uuid,time,os
root=Path(__file__).parent;repo=Path('/Users/zhengchenchen/od-projects/ssl-debug-agent')
fixed=Path(os.environ.get('RDA_FIXED_SOURCE',str(repo)))
suffix=uuid.uuid4().hex[:12];network='rda-import-execution-net-'+suffix;mongo='rda-import-execution-db-'+suffix;helper='rda-import-risk-'+suffix
helper_image='sha256:2183345feff0a0c8c25640fdc8d2e3b111c5baf50d5a1ddb50a43ac5d9cb3dd4'
image=os.environ.get('RDA_MONGO_IMAGE','sha256:9ef36ccfdfb42c68dbc7757af3d1e732eaca253ed0cc529a6dd4d728ea97fd44');label=os.environ.get('RDA_MONGO_LABEL','44')

for ext in ['.tap','-result.json']:
 prior=root/('mongo-'+label+ext)
 if prior.exists():
  i=1
  while (root/('mongo-'+label+'-prior-'+str(i)+ext)).exists():i+=1
  prior.rename(root/('mongo-'+label+'-prior-'+str(i)+ext))
config=root/('synthetic-mongo-config-'+suffix+'.json');config.write_text(json.dumps({'test':{'url':'mongodb://fixture:disposable-fixture-only@mongo:27017/test?replicaSet=fixture&authSource=test','readOnlyUrl':'mongodb://reader:disposable-reader-only@mongo:27017/test?replicaSet=fixture&authSource=test'}}));config.chmod(0o600)
created=[];result={'realMongo':True,'helperImage':helper_image,'databaseImage':image,'network':'internal, no published ports','container':helper,'cleaned':False,'source':str(fixed)}
def run(args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()
try:
 run(['docker','network','create','--internal',network]);created.append(('network',network))
 run(['docker','run','-d','--name',mongo,'--network',network,'--network-alias','mongo','--tmpfs','/data/db:size=512m','--tmpfs','/tmp:exec,size=16m','--entrypoint','bash',image,'-c',"printf 'rdaDisposableFixtureKeyMaterial20261027' > /tmp/fixture-key; chmod 400 /tmp/fixture-key; exec mongod --replSet fixture --bind_ip_all --keyFile /tmp/fixture-key"]);created.append(('container',mongo))
 deadline=time.time()+60
 while True:
  p=subprocess.run(['docker','exec',mongo,'mongo','--quiet','--eval','db.runCommand({ping:1}).ok'],capture_output=True,text=True)
  if p.returncode==0:break
  if time.time()>deadline:raise RuntimeError('isolated Mongo startup timeout')
  time.sleep(0.25)
 run(['docker','exec',mongo,'mongo','--quiet','--eval',"rs.initiate({_id:'fixture',members:[{_id:0,host:'mongo:27017'}]})"])
 while True:
  p=subprocess.run(['docker','exec',mongo,'mongo','--quiet','--eval','db.isMaster().ismaster'],capture_output=True,text=True)
  if p.returncode==0 and p.stdout.strip()=='true':break
  if time.time()>deadline:raise RuntimeError('isolated primary timeout')
  time.sleep(0.25)
 run(['docker','exec',mongo,'mongo','admin','--quiet','--eval',"db.createUser({user:'fixtureAdmin',pwd:'disposable-admin-only',roles:['root']})"])
 run(['docker','exec',mongo,'mongo','test','--quiet','-u','fixtureAdmin','-p','disposable-admin-only','--authenticationDatabase','admin','--eval',"db.createUser({user:'fixture',pwd:'disposable-fixture-only',roles:[{role:'readWrite',db:'test'}]})"])
 run(['docker','exec',mongo,'mongo','test','--quiet','-u','fixtureAdmin','-p','disposable-admin-only','--authenticationDatabase','admin','--eval',"db.createUser({user:'reader',pwd:'disposable-reader-only',roles:[{role:'read',db:'test'}]})"])
 run(['docker','run','-d','--name',helper,'--network',network,'--read-only','--tmpfs','/tmp:exec,size=256m','-v',str(config)+':/home/app/config.json:ro',helper_image,'node','-e','setInterval(()=>{},60000)']);created.append(('container',helper))
 env=dict(os.environ);env['RDA_IMPORT_TEST_CONTAINER']=helper
 with (root/('mongo-'+label+'.tap')).open('w') as out:
  p=subprocess.run(['/Users/zhengchenchen/.nvm/versions/node/v22.23.3/bin/node','--test',str(fixed/'agent/test/import-execution-mongo.e2e.mjs')],env=env,stdout=out,stderr=subprocess.STDOUT)
 result['exitCode']=p.returncode
finally:
 cleanup=[]
 for kind,name in reversed(created):
  p=subprocess.run(['docker',kind,'rm']+(['-f'] if kind=='container' else [])+[name],capture_output=True,text=True);cleanup.append({'type':kind,'name':name,'exitCode':p.returncode})
 result['cleanup']=cleanup;result['cleaned']=all(x['exitCode']==0 for x in cleanup)
 config.unlink(missing_ok=True)
 (root/('mongo-'+label+'-result.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result))
