/**
 * Where Montra may connect for someone's storage (ADR-0031 §3). The owner names the host, so in production the API refuses private,
 * loopback, link-local and metadata addresses, and plain http. The address is checked as each connection is made, through the
 * socket's `lookup`, so a name that resolves somewhere else later (DNS rebinding) is caught too.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { DestinationError } from './types.js';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64, which can reach private IPv4
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** `::ffff:10.0.0.1` or `::ffff:a00:1` → `10.0.0.1`. BlockList matches IPv4 rules against these, but not reliably every form. */
function mappedIpv4(address: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(address);
  if (!m) return null;
  if (isIP(m[1]!) === 4) return m[1]!;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]!);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = mappedIpv4(address);
    // Mapped addresses have no business here, public or not.
    return v4 !== null || blocked.check(address, 'ipv6');
  }
  return true;
}

export interface HostPolicy {
  /** Allow private addresses and plain http: self-hosting, development and tests. */
  allowPrivate: boolean;
}

/** Refuses an address before any connection is tried. */
export function assertAllowedUrl(url: URL, policy: HostPolicy): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new DestinationError('invalid', url.protocol);
  if (policy.allowPrivate) return;
  if (url.protocol !== 'https:') throw new DestinationError('not_allowed_host', 'http');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? isBlockedAddress(host) : host === 'localhost' || host.endsWith('.localhost')) {
    throw new DestinationError('not_allowed_host', host);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A socket `lookup` that refuses blocked addresses. */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
) {
  dnsLookup(hostname, { family: options.family ?? 0, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      return callback(
        new DestinationError('not_allowed_host', hostname) as unknown as NodeJS.ErrnoException,
        '',
      );
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
}

/** Agents for one connection's requests. Without keep-alive, so nothing lingers between runs. */
export function agentsFor(policy: HostPolicy): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  const lookup = policy.allowPrivate ? undefined : (guardedLookup as unknown as http.AgentOptions['lookup']);
  return {
    httpAgent: new http.Agent({ keepAlive: false, ...(lookup ? { lookup } : {}) }),
    httpsAgent: new https.Agent({ keepAlive: false, ...(lookup ? { lookup } : {}) }),
  };
}
