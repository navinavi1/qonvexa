const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BALANCE_OF_SELECTOR = '70a08231';

export function isEvmAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ''));
}

export async function readBaseBalances({ address, rpcUrl = 'https://mainnet.base.org', timeoutMs = 8000 } = {}) {
  if (!isEvmAddress(address)) return { ok:false, error:'invalid_owner_wallet' };
  try {
    const [nativeHex, usdcHex] = await Promise.all([
      rpc(rpcUrl, 'eth_getBalance', [address, 'latest'], timeoutMs),
      rpc(rpcUrl, 'eth_call', [{ to: BASE_USDC, data: encodeBalanceOf(address) }, 'latest'], timeoutMs)
    ]);
    return {
      ok: true,
      network: 'Base',
      chainId: 8453,
      address,
      eth: hexUnits(nativeHex, 18),
      usdc: hexUnits(usdcHex, 6),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return { ok:false, address, error: String(error?.message || error).slice(0, 300), checkedAt:new Date().toISOString() };
  }
}

async function rpc(url, method, params, timeoutMs) {
  const response = await fetch(url, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
    signal:AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`rpc_${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || 'rpc_error');
  return body.result;
}

function encodeBalanceOf(address) {
  return `0x${BALANCE_OF_SELECTOR}${address.toLowerCase().replace(/^0x/,'').padStart(64,'0')}`;
}

function hexUnits(hex, decimals) {
  const value = BigInt(hex || '0x0');
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return Number(`${whole}${fraction ? `.${fraction}` : ''}`);
}
