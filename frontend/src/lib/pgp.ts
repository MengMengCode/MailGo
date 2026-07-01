type OpenPGP = typeof import("openpgp");

let openPGPPromise: Promise<OpenPGP> | undefined;

async function loadOpenPGP(): Promise<OpenPGP> {
  // WebCrypto is intentionally unavailable on public HTTP origins. Keep
  // OpenPGP out of the startup bundle so the rest of MailGo still works when
  // accessed directly through http://IP:port.
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "PGP encryption requires HTTPS (or localhost) because WebCrypto is unavailable on this HTTP origin.",
    );
  }
  openPGPPromise ??= import("openpgp");
  return openPGPPromise;
}

/**
 * Generate a new RSA-4096 PGP key pair.
 * Returns armored public and private keys.
 */
export async function generateKeyPair(
  name: string,
  email: string,
): Promise<{ publicKey: string; privateKey: string }> {
  const openpgp = await loadOpenPGP();
  const key = await openpgp.generateKey({
    type: "rsa",
    rsaBits: 4096,
    userIDs: [{ name, email }],
    format: "armored",
  });
  return {
    publicKey: key.publicKey,
    privateKey: key.privateKey,
  };
}

/**
 * Encrypt a plaintext string with the given armored public key.
 * Returns an armored PGP message.
 */
export async function encryptMessage(
  plaintext: string,
  publicKeyArmored: string,
): Promise<string> {
  const openpgp = await loadOpenPGP();
  const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored });
  const message = await openpgp.createMessage({ text: plaintext });
  const encrypted = await openpgp.encrypt({
    message,
    encryptionKeys: publicKey,
  });
  return encrypted;
}

/**
 * Try to decrypt an armored PGP message with the given private key.
 * Returns the plaintext on success, or null on failure.
 */
export async function tryDecrypt(
  ciphertext: string,
  privateKeyArmored: string,
  passphrase?: string,
): Promise<string | null> {
  try {
    const openpgp = await loadOpenPGP();
    const privateKey = await openpgp.readPrivateKey({
      armoredKey: privateKeyArmored,
    });
    const message = await openpgp.readMessage({ armoredMessage: ciphertext });

    // If the key is locked, try to unlock it.
    let decryptKey = privateKey;
    if (privateKey.isDecrypted() === false && passphrase) {
      decryptKey = await openpgp.decryptKey({
        privateKey,
        passphrase,
      });
    }

    const { data: plaintext } = await openpgp.decrypt({
      message,
      decryptionKeys: decryptKey,
    });
    return typeof plaintext === "string" ? plaintext : null;
  } catch {
    return null;
  }
}

/**
 * Detect whether a text block looks like a PGP encrypted message.
 */
export function isPGPMessage(text: string): boolean {
  return (
    text.includes("-----BEGIN PGP MESSAGE-----") &&
    text.includes("-----END PGP MESSAGE-----")
  );
}

/**
 * Extract the fingerprint from an armored public key (for display).
 * Returns a short fingerprint or null on error.
 */
export async function getKeyFingerprint(
  publicKeyArmored: string,
): Promise<string | null> {
  try {
    const openpgp = await loadOpenPGP();
    const key = await openpgp.readKey({ armoredKey: publicKeyArmored });
    return key.getFingerprint().toUpperCase();
  } catch {
    return null;
  }
}
