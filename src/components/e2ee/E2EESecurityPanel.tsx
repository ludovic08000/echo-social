import { useEffect, useState } from 'react';
import { fetchActiveDevices, fetchTransparencyLog } from '@/lib/crypto';

interface Props {
  userId: string;
  fingerprint: string;
}

export default function E2EESecurityPanel({ userId, fingerprint }: Props) {
  const [devices, setDevices] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    void fetchActiveDevices(userId).then(setDevices).catch(() => {});
    void fetchTransparencyLog(userId).then(setLogs).catch(() => {});
  }, [userId]);

  return (
    <div className="space-y-6 rounded-xl border p-4">
      <div>
        <h2 className="text-lg font-semibold">E2EE Security</h2>
        <p className="text-sm opacity-70">Fingerprint: {fingerprint}</p>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Trusted Devices</h3>
        <div className="space-y-2 text-sm">
          {devices.map((d) => (
            <div key={d.deviceId} className="rounded border p-2">
              <div>{d.deviceId}</div>
              <div className="opacity-70">Epoch {d.identityEpoch}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="font-medium">Transparency Log</h3>
        <div className="space-y-2 text-xs max-h-64 overflow-auto">
          {logs.map((l, i) => (
            <div key={i} className="rounded border p-2">
              <div>{l.event_type}</div>
              <div className="opacity-70">{l.created_at}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
