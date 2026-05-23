import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";

const CERT_VALID_YEARS = 30;

function randomSerial() {
  return forge.util.bytesToHex(forge.random.getBytesSync(9));
}

function sanitizeHost(hostname) {
  return hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function readIfExists(filePath) {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function createRootCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  const rootNotAfter = new Date(now);
  rootNotAfter.setFullYear(rootNotAfter.getFullYear() + CERT_VALID_YEARS);
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = rootNotAfter;

  const attrs = [
    { name: "commonName", value: "Maven Proxy Root CA" },
    { name: "organizationName", value: "maven-proxy" },
    { shortName: "OU", value: "Development" },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    {
      name: "keyUsage",
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
    privateKey: keys.privateKey,
    certificate: cert,
  };
}

function createLeafCertificate(hostname, rootPrivateKey, rootCertificate) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerial();

  const now = new Date();
  const leafNotAfter = new Date(now);
  leafNotAfter.setFullYear(leafNotAfter.getFullYear() + CERT_VALID_YEARS);
  cert.validity.notBefore = new Date(now.getTime() - 60 * 60 * 1000);
  cert.validity.notAfter = leafNotAfter;

  cert.setSubject([
    { name: "commonName", value: hostname },
    { name: "organizationName", value: "maven-proxy-leaf" },
  ]);

  cert.setIssuer(rootCertificate.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
      dataEncipherment: true,
      critical: true,
    },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [{ type: 2, value: hostname }],
    },
    { name: "subjectKeyIdentifier" },
  ]);

  cert.sign(rootPrivateKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

export class CertManager {
  constructor(config) {
    this.config = config;
    this.rootPrivateKey = null;
    this.rootCertificate = null;
    this.leafCache = new Map();
    this.leafPromiseCache = new Map();
  }

  async init() {
    await ensureDir(path.dirname(this.config.rootCertPath));
    await ensureDir(path.dirname(this.config.rootKeyPath));
    await ensureDir(this.config.leafCertDir);

    const certPem = await readIfExists(this.config.rootCertPath);
    const keyPem = await readIfExists(this.config.rootKeyPath);

    if (certPem && keyPem) {
      this.rootCertificate = forge.pki.certificateFromPem(certPem);
      this.rootPrivateKey = forge.pki.privateKeyFromPem(keyPem);
      return;
    }

    const root = createRootCertificate();
    this.rootCertificate = root.certificate;
    this.rootPrivateKey = root.privateKey;

    await fs.promises.writeFile(this.config.rootCertPath, root.certPem, "utf8");
    await fs.promises.writeFile(this.config.rootKeyPath, root.keyPem, "utf8");
  }

  async getRootCertPem() {
    return fs.promises.readFile(this.config.rootCertPath, "utf8");
  }

  async getOrCreateLeaf(hostname) {
    const normalizedHost = String(hostname).toLowerCase();

    if (this.leafCache.has(normalizedHost)) {
      return this.leafCache.get(normalizedHost);
    }

    if (this.leafPromiseCache.has(normalizedHost)) {
      return this.leafPromiseCache.get(normalizedHost);
    }

    const promise = this.#loadOrCreateLeaf(normalizedHost)
      .then((leaf) => {
        this.leafCache.set(normalizedHost, leaf);
        return leaf;
      })
      .finally(() => {
        this.leafPromiseCache.delete(normalizedHost);
      });

    this.leafPromiseCache.set(normalizedHost, promise);
    return promise;
  }

  async #loadOrCreateLeaf(hostname) {
    const safeHost = sanitizeHost(hostname);
    const certPath = path.join(this.config.leafCertDir, `${safeHost}.crt`);
    const keyPath = path.join(this.config.leafCertDir, `${safeHost}.key.pem`);

    const certPem = await readIfExists(certPath);
    const keyPem = await readIfExists(keyPath);

    if (certPem && keyPem) {
      return { certPem, keyPem };
    }

    const leaf = createLeafCertificate(hostname, this.rootPrivateKey, this.rootCertificate);
    await fs.promises.writeFile(certPath, leaf.certPem, "utf8");
    await fs.promises.writeFile(keyPath, leaf.keyPem, "utf8");

    return leaf;
  }
}
