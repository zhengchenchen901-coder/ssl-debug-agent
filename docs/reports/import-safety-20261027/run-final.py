from pathlib import Path
import subprocess,json,os,hashlib,concurrent.futures
root=Path('/Users/zhengchenchen/Documents/Codex/2026-10-27/ssl-debug-agent-import-safety');repo=Path('/Users/zhengchenchen/od-projects/ssl-debug-agent')
receipt=json.loads((root/'testflow-freeze.json').read_text());snapshot=root/'.testflow/snapshots'/receipt['target']['contentHash'];fixed=snapshot/'files';image=(root/'native-image-id.txt').read_text().strip()
node='/Users/zhengchenchen/.nvm/versions/node/v22.23.3/bin/node';env=dict(os.environ);env['PATH']=str(Path(node).parent)+':'+env['PATH']
if (root/'container-regression.tap').exists():(root/'pre-portable-fixture-container-regression.tap').write_bytes((root/'container-regression.tap').read_bytes())
def regression():
 with (root/'container-regression.tap').open('w') as out:
  p=subprocess.run(['docker','run','--rm','--name','rda-import-safety-regression-20261027','--network','none','--read-only','--tmpfs','/workspace:exec,size=768m','--tmpfs','/tmp:exec,size=512m','-v',str(fixed)+':/fixed:ro','-v',str(root/'run-regression.sh')+':/run-regression.sh:ro',image,'sh','/run-regression.sh'],stdout=out,stderr=subprocess.STDOUT)
 (root/'container-regression-result.json').write_text(json.dumps({'snapshotId':receipt['snapshotId'],'image':image,'network':'none','exitCode':p.returncode,'supplementalEvidence':True,'testflowExecution':False,'keystore':'explicit synthetic PrivacyService key in memory proxy fixture; production Linux unsupported gate unchanged'},indent=2));return p.returncode
def browser(kind):
 browserenv=dict(env);browserenv['RDA_RISK_BROWSER_OUTPUT']=str(root/('browser-'+kind))
 with (root/('browser-'+kind+'.json')).open('w') as out,(root/('browser-'+kind+'.stderr')).open('w') as err:
  p=subprocess.run([node,str(repo/'agent/test/risk-replacement-browser.e2e.mjs')]+(['--import'] if kind=='import' else []),env=browserenv,cwd=repo,stdout=out,stderr=err)
 return p.returncode
def mongo():return subprocess.run(['python3',str(root/'run-mongo.py')]).returncode
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 jobs={'regression':pool.submit(regression),'mongo':pool.submit(mongo),'browserImport':pool.submit(browser,'import'),'browserBulk':pool.submit(browser,'bulk')};status={k:v.result() for k,v in jobs.items()}
files=json.loads((snapshot/'manifest.json').read_text())['files'];mismatch=[]
for f in files:
 if f.get('contentHash') and hashlib.sha256((repo/f['file']).read_bytes()).hexdigest()!=f['contentHash']:mismatch.append(f['file'])
runtime=repo/'plugins/remote-debug-agent/runtime/agent';manifest=json.loads((runtime/'runtime-manifest.json').read_text());runtimeMismatch=[f for f,h in manifest['hashes'].items() if hashlib.sha256((runtime/f).read_bytes()).hexdigest()!=h]
status.update({'snapshotId':receipt['snapshotId'],'sourceMatchesFrozenFiles':not mismatch,'changedFrozenFiles':mismatch,'runtimeManifestVerified':not runtimeMismatch,'runtimeId':manifest['runtimeId']})
(root/'final-verification.json').write_text(json.dumps(status,indent=2));print(json.dumps(status));assert all(status[k]==0 for k in jobs) and not mismatch and not runtimeMismatch
