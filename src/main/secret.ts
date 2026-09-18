/**
 * API Key 的加密存储：基于 Electron 内置 safeStorage，不引第三方加密库。
 *
 * 降级策略（安全底线）：当 safeStorage.isEncryptionAvailable() 为假时，
 * **绝不降级为明文落盘**，改为仅在本进程内存持有密钥；此时：
 * - saveSecret 返回 undefined，配置文件里不写入任何密文；
 * - 渲染层通过 PublicConfig.safeStorageAvailable = false 获知，设置页显示黄条提示。
 */
import { safeStorage } from 'electron';

/** 不可用时的内存密钥槽：key = providerId */
const memorySecrets = new Map<string, string>();

/** 当前环境是否支持安全存储 */
export function isEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 明文 → base64 密文 */
function encryptToBase64(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64');
}

/** base64 密文 → 明文；解密失败返回 undefined */
function decryptFromBase64(encoded: string): string | undefined {
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return undefined;
  }
}

/**
 * 保存密钥。
 * @param slot 密钥槽位（一般用 providerId，保证各家互不覆盖）
 * @param plain 明文密钥；传入空字符串表示清除
 * @returns 需要写入配置文件的密文；返回 undefined 表示「不落盘」（已清除或仅内存持有）
 */
export function saveSecret(slot: string, plain: string): string | undefined {
  if (!plain) {
    memorySecrets.delete(slot);
    return undefined;
  }
  if (!isEncryptionAvailable()) {
    memorySecrets.set(slot, plain);
    return undefined;
  }
  memorySecrets.delete(slot);
  return encryptToBase64(plain);
}

/**
 * 读取密钥：优先解密配置文件中的密文，其次取内存副本。
 * @returns 明文密钥；两者都没有时返回 undefined
 */
export function loadSecret(slot: string, encrypted: string | undefined): string | undefined {
  if (encrypted) {
    return decryptFromBase64(encrypted);
  }
  return memorySecrets.get(slot);
}

/**
 * 是否存在**可用**密钥（用于 PublicConfig.hasApiKey 脱敏展示）。
 *
 * 不使用「密文是否存在」作为判据：密文存在但解密失败（换机器、系统钥匙串变更）
 * 时，配置页会显示「已配置」而发送却报「未配置」，属于自相矛盾。
 * 这里以「能否真正解出非空明文」为准。
 */
export function hasSecret(slot: string, encrypted: string | undefined): boolean {
  const plain = loadSecret(slot, encrypted);
  return typeof plain === 'string' && plain.length > 0;
}
