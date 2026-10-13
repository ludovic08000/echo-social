import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { registerPlaintextRetention, confirmPlaintextPermanent, savePlaintext, savePlaintextForCiphertext, loadPlaintext,
  loadPlaintextForCiphertext, exportPlaintextCache, importPlaintextCache, wipePlaintextStore } from '../plaintextStore';
beforeEach(async()=>{await wipePlaintextStore();});
it('keeps normal messages in backups but excludes ephemeral messages even before read',async()=>{
  await savePlaintext('normal','ordinary');
  await registerPlaintextRetention('ephemeral','encrypted-body',null);
  await savePlaintext('ephemeral','secret');await savePlaintextForCiphertext('encrypted-body','secret');
  expect(await loadPlaintext('ephemeral')).toBe('secret');
  const backup=await exportPlaintextCache();
  expect(backup).toEqual([{id:'normal',plaintext:'ordinary'}]);
});
it('erases all aliases and rejects restoration and racing late writes after expiration',async()=>{
  await registerPlaintextRetention('message','cipher',null);
  await savePlaintext('message','secret');await savePlaintextForCiphertext('cipher','secret');
  await registerPlaintextRetention('message',null,Date.now()-1);
  await importPlaintextCache([{id:'message',plaintext:'restored secret'}]);
  await savePlaintextForCiphertext('cipher','late decryption');
  expect(await loadPlaintext('message')).toBeNull();
  expect(await loadPlaintextForCiphertext('cipher')).toBeNull();
  expect(await exportPlaintextCache()).toEqual([]);
});
it('never extends known expiration when stale metadata arrives',async()=>{
  await registerPlaintextRetention('message','cipher',Date.now()-100);
  await registerPlaintextRetention('message','cipher',null);
  await registerPlaintextRetention('message','cipher',Date.now()+86400000);
  await savePlaintext('message','must not return');
  expect(await loadPlaintext('message')).toBeNull();
});
it('allows a confirmed normal send into backups, but never releases an ephemeral marker',async()=>{
  await registerPlaintextRetention('draft',null,null,true);
  await savePlaintext('draft','normal send');
  expect(await exportPlaintextCache()).toEqual([]);
  await confirmPlaintextPermanent('draft');
  expect(await exportPlaintextCache()).toEqual([{id:'draft',plaintext:'normal send'}]);
  await registerPlaintextRetention('draft',null,null,false);
  await registerPlaintextRetention('draft',null,null,true);
  await confirmPlaintextPermanent('draft');
  expect(await exportPlaintextCache()).toEqual([]);
});
