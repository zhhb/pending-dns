'use strict';

const config = require('wild-config');
const pkg = require('../package.json');
const db = require('./db');
const punycode = require('punycode');
const { zoneStore } = require('./zone-store');
const crypto = require('crypto');
const { checkNSStatus } = require('./tools');
const ACME = require('@root/acme');
const { pem2jwk } = require('pem-jwk');
const NodeRSA = require('node-rsa');
const logger = require('./logger').child({ component: 'certs' });
const CSR = require('@root/csr');
const { Certificate } = require('@fidm/x509');

const acme = ACME.create({
    maintainerEmail: pkg.author.email,
    packageAgent: pkg.name + '/' + pkg.version,
    notify(ev, params) {
        logger.info({ msg: 'ACME notification', ev, params });
    }
});

let acmeInitialized = false;
let acmeInitializing = false;
let acmeInitPending = [];
const ensureAcme = async () => {
    if (acmeInitialized) {
        return true;
    }
    if (acmeInitializing) {
        return new Promise((resolve, reject) => {
            acmeInitPending.push({ resolve, reject });
        });
    }

    try {
        await acme.init(config.acme.directoryUrl);
        acmeInitialized = true;

        if (acmeInitPending.length) {
            for (let entry of acmeInitPending) {
                entry.resolve(true);
            }
        }
    } catch (err) {
        if (acmeInitPending.length) {
            for (let entry of acmeInitPending) {
                entry.reject(err);
            }
        }
        throw err;
    } finally {
        acmeInitializing = false;
    }

    return true;
};

const generateKey = async bits => {
    const key = new NodeRSA({ b: bits || 2048, e: 65537 });
    const pem = key.exportKey('pkcs1-private-pem');
    return pem;
};

class AcmeDNSPlugin {
    constructor() {
        this.propagationDelay = 1000;
    }

    init(/*{ request }*/) {
        // { request: { get, post, put, delete } }
        return null;
    }

    async zones({ challenge }) {
        let zones = new Set();

        for (let host of challenge.dnsHosts) {
            let zone = await zoneStore.resolveDomainZone(host);
            if (zone) {
                zones.add(zone);
            }
        }

        return Array.from(zones);
    }

    async set({ challenge }) {
        // { type: 'dns-01'
        // , identifier: { type: 'dns', value: 'foo.example.com' }
        // , wildcard: false
        // , dnsHost: '_acme-challenge.foo.example.com'
        // , dnsPrefix: '_acme-challenge.foo'
        // , dnsZone: 'example.com'
        // , dnsAuthorization: 'zzzz' }

        let record = await zoneStore.add(challenge.dnsZone, challenge.dnsPrefix, 'TXT', [challenge.dnsAuthorization]);
        if (!record) {
            throw new Error('Failed to store record');
        }
        return true;
    }

    async get({ challenge }) {
        let entry = await zoneStore.resolve(challenge.dnsHost, 'TXT', true);
        if (entry && entry.length && entry[0].value && entry[0].value.length) {
            return { dnsAuthorization: entry[0].value[0] };
        }

        return null;
    }

    async remove({ challenge }) {
        let deleted = await zoneStore.deleteDomain(challenge.dnsHost, 'TXT');

        if (!deleted) {
            throw new Error('TXT Record not found for removal');
        }

        return true;
    }
}

let getAcmeAccount = async () => {
    await ensureAcme();

    const id = config.acme.key;
    const entryKey = `d:acme:account:${id}`;

    const acmeAccount = await db.redisRead.hgetall(entryKey);
    if (acmeAccount && acmeAccount.account) {
        try {
            acmeAccount.account = JSON.parse(acmeAccount.account);
        } catch (err) {
            throw new Error('Failed to retrieve ACME account');
        }
        if (acmeAccount.created) {
            acmeAccount.created = new Date(acmeAccount.created);
        }
        return acmeAccount;
    }

    // account not found, create a new one
    logger.warn({ msg: 'ACME account not found, provisioning new one', account: id, directory: config.acme.directoryUrl });
    const accountKey = await generateKey();
    const jwkAccount = pem2jwk(accountKey);
    logger.info({ msg: 'Generated Acme account key', account: id });

    const accountOptions = {
        subscriberEmail: config.acme.email,
        agreeToTerms: true,
        accountKey: jwkAccount
    };

    const account = await acme.accounts.create(accountOptions);

    await db.redisWrite.hmset(entryKey, {
        key: accountKey,
        account: JSON.stringify(account),
        created: new Date().toISOString()
    });

    logger.info({ msg: 'ACME account provisioned', account: id, directory: config.acme.directoryUrl });
    return { key: accountKey, account };
};

let getDomainList = async domains => {
    domains = []
        .concat(domains || [])
        .map(domain => {
            domain = (domain || '').toString().trim().toLowerCase();
            if (!domain) {
                return false;
            }
            try {
                return punycode.toASCII(domain).trim().toLowerCase();
            } catch (err) {
                return false;
            }
        })
        .filter(domain => domain)
        .sort((a, b) => a.localeCompare(b));

    domains = Array.from(new Set(domains));

    // filter domains that have existing zones and correct name servers
    let canUse = [];
    for (let domain of domains) {
        // resolve zone
        let zone = await zoneStore.resolveDomainZone(domain);
        if (!zone) {
            logger.info({ msg: 'Rejecting domain for cert', domain, reason: 'No zone found' });
            continue;
        }
        let nsStatus = await checkNSStatus(zone, config.ns);
        if (nsStatus.status !== 'valid') {
            logger.info({ msg: 'Rejecting domain for cert', domain, reason: 'NS failure', nsStatus });
            continue;
        }
        canUse.push({ domain, zone });
    }

    return canUse;
};

let formatCertificateData = certificateData => {
    if (!certificateData) {
        return false;
    }
    ['validFrom', 'expires', 'lastCheck', 'created'].forEach(key => {
        if (certificateData[key] && typeof certificateData[key] === 'string') {
            certificateData[key] = new Date(certificateData[key]);
        }
    });

    ['dnsNames'].forEach(key => {
        if (certificateData[key] && typeof certificateData[key] === 'string') {
            try {
                certificateData[key] = JSON.parse(certificateData[key]);
            } catch (err) {
                certificateData[key] = false;
            }
        }
    });

    return certificateData;
};

let renewCertificate = async (domains, force) => {
    await ensureAcme();

    domains = await getDomainList(domains);
    if (!domains.length) {
        throw new Error('No valid domain names provided');
    }

    let certKey = `d:acme:keys:${crypto
        .createHash('md5')
        .update(domains.map(domain => domain.domain).join(':'))
        .digest('hex')}`;

    let certificateData = await db.redisRead.hgetall(certKey);
    certificateData = formatCertificateData(certificateData);

    if (!force && certificateData && certificateData.expires > new Date(Date.now() + 30 * 24 * 3600 * 1000)) {
        // no need to renew
        return certificateData;
    }

    let privateKey = certificateData && certificateData.key;
    if (!privateKey) {
        // generate new key
        logger.error({ msg: 'Provision new private key', domains });
        privateKey = await generateKey();
        await db.redisWrite.hset(certKey, 'key', privateKey);
    }
    const jwkPrivateKey = pem2jwk(privateKey);

    const csr = await CSR.csr({
        jwk: jwkPrivateKey,
        domains: domains.map(domain => domain.domain),
        encoding: 'pem'
    });

    const acmeAccount = await getAcmeAccount();
    if (!acmeAccount) {
        logger.error({ msg: 'Skip certificate renwal, acme account not found', domains });
        return false;
    }

    const jwkAccount = pem2jwk(acmeAccount.key);
    const certificateOptions = {
        account: acmeAccount.account,
        accountKey: jwkAccount,
        csr,
        domains: domains.map(domain => domain.domain),
        challenges: {
            'dns-01': new AcmeDNSPlugin()
        }
    };

    const cert = await acme.certificates.create(certificateOptions);
    if (!cert || !cert.cert) {
        return cert;
    }

    let now = new Date();
    const parsed = Certificate.fromPEM(cert.cert);
    let result = {
        cert: cert.cert,
        chain: cert.chain,
        validFrom: new Date(parsed.validFrom).toISOString(),
        expires: new Date(parsed.validTo).toISOString(),
        dnsNames: JSON.stringify(parsed.dnsNames),
        issuer: parsed.issuer.CN,
        lastCheck: now.toISOString(),
        created: now.toISOString(),
        status: 'valid'
    };

    let updates = {};
    Object.keys(result).forEach(key => {
        updates[key] = (result[key] || '').toString();
    });

    await db.redisWrite.hmset(certKey, updates);

    logger.warn({ msg: 'Certificate successfully renewed', domains, expires: parsed.validTo });

    certificateData = await db.redisRead.hgetall(certKey);
    return formatCertificateData(certificateData);
};

module.exports = {
    renewCertificate
};