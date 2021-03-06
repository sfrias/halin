import nd from '../neo4jDesktop/index';
import ClusterNode from '../data/ClusterNode';
import DataFeed from '../data/DataFeed';
import _ from 'lodash';
import Promise from 'bluebird';
import uuid from 'uuid';
import moment from 'moment';
import appPkg from '../package.json';
import ClusterManager from './cluster/ClusterManager';
import queryLibrary from '../data/query-library';
import * as Sentry from '@sentry/browser';
import neo4j from '../driver';

/**
 * HalinContext is a controller object that keeps track of state and permits diagnostic
 * reporting.
 * 
 * It creates its own drivers and does not use the Neo4j Desktop API provided drivers.
 * The main app will attach it to the window object as a global.
 */
export default class HalinContext {
    domain = 'halin';

    constructor() {
        this.project = null;
        this.graph = null;
        this.drivers = {};
        this.dataFeeds = {};
        this.pollRate = 1000;
        this.driverOptions = {
            connectionTimeout: 10000,
            trust: 'TRUST_CUSTOM_CA_SIGNED_CERTIFICATES',
        };
        this.debug = false;
        this.mgr = new ClusterManager(this);
    }

    getPollRate() {
        return this.pollRate;
    }

    /**
     * @returns {ClusterManager}
     */
    getClusterManager() {
        return this.mgr;
    }

    getFeedsFor(clusterNode) {
        return _.values(this.dataFeeds).filter(df => df.node === clusterNode);
    }

    getDataFeed(feedOptions) {
        const df = new DataFeed(feedOptions);
        const feed = this.dataFeeds[df.name];
        if (feed) {
            return feed;
        }
        this.dataFeeds[df.name] = df;
        // console.log('Halin starting new DataFeed: ', df.name.slice(0, 120) + '...');
        df.start();
        return df;
    }

    /**
     * Create a new driver for a given address.
     */
    driverFor(addr, username = _.get(this.base, 'username'), password = _.get(this.base, 'password')) {
        const tlsLevel = _.get(this.base, 'tlsLevel');
        const encrypted = (tlsLevel === 'REQUIRED' ? true : false);

        if (this.drivers[addr]) {
            return this.drivers[addr];
        }

        const allOptions = _.merge({ encrypted }, this.driverOptions);
        if (this.debug) {
            console.log('Driver connection', { addr, username, allOptions });
        }
        const driver = neo4j.driver(addr,
            neo4j.auth.basic(username, password), allOptions);

        this.drivers[addr] = driver;
        return driver;
    }

    shutdown() {
        console.log('Shutting down halin context');
        _.values(this.dataFeeds).map(df => df.stop);
        _.values(this.drivers).map(driver => driver.close());
    }

    /**
     * Returns true if the context is attached to a Neo4j Enterprise Edition server
     * with more than one cluster node.
     */
    isCluster() {
        // Must have more than one node
        return this.clusterNodes && this.clusterNodes.length > 1;
    }

    /**
     * Returns true if the context is attached to a Neo4j Enterprise edition server,
     * false otherwise.
     */
    isEnterprise() {
        return this.clusterNodes[0].isEnterprise();
    }

    /**
     * Returns true if the context provides for native auth management, false otherwise.
     */
    supportsNativeAuth() {
        return this.clusterNodes[0].supportsNativeAuth();
    }

    /**
     * Starts a slow data feed for the node's cluster role.  In this way, if the leader
     * changes, we can detect it.
     */
    watchForClusterRoleChange(clusterNode) {
        const roleFeed = this.getDataFeed(_.merge({
            node: clusterNode,
            driver: this.driverFor(clusterNode.getBoltAddress()),
        }, queryLibrary.CLUSTER_ROLE));

        const addr = clusterNode.getBoltAddress();
        const onRoleData = (newData, dataFeed) => {
            const newRole = newData.data[0].role;

            // Something in cluster topology just changed...
            if (newRole !== clusterNode.role) {
                const oldRole = clusterNode.role;
                clusterNode.role = newRole;

                this.getClusterManager().addEvent({
                    date: new Date(),
                    message: `Role change from ${oldRole} to ${newRole}`,
                    address: clusterNode.getBoltAddress(),
                });
            }
        };

        const onError = (err, dataFeed) => {
            Sentry.captureException(err);
            console.error('HalinContext: failed to get cluster role for ', addr, err);
        };

        roleFeed.addListener(onRoleData);
        roleFeed.onError = onError;
        return roleFeed;
    }

    checkForCluster(activeDb) {
        const session = this.base.driver.session();
        // console.log('activeDb', activeDb);
        return session.run('CALL dbms.cluster.overview()', {})
            .then(results => {
                this.clusterNodes = results.records.map(rec => new ClusterNode(rec))

                return this.clusterNodes.map(clusterNode => this.watchForClusterRoleChange(clusterNode));
            })
            .catch(err => {
                const str = `${err}`;
                if (str.indexOf('no procedure') > -1) {
                    // Halin will look at single node databases
                    // running in desktop as clusters of size 1.
                    const rec = {
                        id: uuid.v4(),
                        addresses: nd.getAddressesForGraph(activeDb.graph),
                        role: 'SINGLE',
                        database: 'default',
                    };

                    // Psuedo object behaves like a cypher result record.
                    // Somewhere, a strong typing enthusiast is screaming. ;)
                    const get = key => rec[key];
                    rec.get = get;

                    this.clusterNodes = [new ClusterNode(rec)];
                } else {
                    Sentry.captureException(err);
                    throw err;
                }
            })
            .then(() => Promise.all(this.clusterNodes.map(cn => {
                const driver = this.driverFor(cn.getBoltAddress());
                return cn.checkComponents(driver);
            })))
            .then(() => 
                Promise.all(this.clusterNodes.map(cn => this.ping(cn))))
            .finally(() => session.close());
    }

    /**
     * Take a diagnostic package and return a cleaned up version of the same, removing
     * sensitive data that shouldn't go out.
     * This function intentionally modifies its argument.
     */
    cleanup(pkg) {
        const deepReplace = (keyToClean, newVal, object) => {
            let found = false;

            _.each(object, (val, key) => {
                if (key === keyToClean) {
                    found = true;
                } else if (_.isArray(val)) {
                    object[key] = val.map(v => deepReplace(keyToClean, newVal, v));
                } else if (_.isObject(val)) {

                    object[key] = deepReplace(keyToClean, newVal, val);
                }
            });

            if (found) {
                const copy = _.cloneDeep(object);
                copy[keyToClean] = newVal;
                return copy;
            }

            return object;
        };

        return deepReplace('password', '********', _.cloneDeep(pkg));
    }

    getCurrentUser() {
        return this.currentUser;
    }

    checkUser(driver) {
        const q = 'call dbms.showCurrentUser()';
        const session = driver.session();

        return session.run(q, {})
            .then(results => {
                const rec = results.records[0];

                let roles = [];
                try {
                    // Community doesn't expose this field, and
                    // it's an ignorable error
                    roles = rec.get('roles');
                } catch (e) { ; }

                this.currentUser = {
                    username: rec.get('username'),
                    roles,
                    flags: rec.get('flags'),
                };
                
                // console.log('Current User', this.currentUser);
            })
            .catch(err => {
                Sentry.captureException(err);
                console.error('Failed to get user info');
                this.currentUser = {
                    username: 'UNKNOWN',
                    roles: [],
                    flags: [],
                };
            })
            .finally(() => session.close());
    }

    static getProjectFromEnvironment() {
        return {
            name: process.env.GRAPH_NAME || 'environment',
            graphs: [
                HalinContext.getGraphFromEnvironment(),
            ],
        };
    }

    static getGraphFromEnvironment() {
        const encryption = process.env.ENCRYPTION_REQUIRED ? 'REQUIRED' : 'OPTIONAL';
        const host = process.env.NEO4J_HOST || 'localhost';
        const port = process.env.NEO4J_PORT || 7687;
        const username = process.env.NEO4J_USERNAME || 'neo4j';
        const password = process.env.NEO4J_PASSWORD || 'admin';

        return {
            name: process.env.GRAPH_NAME || 'environment',
            status: process.env.GRAPH_STATUS || 'ACTIVE',
            databaseStatus: process.env.DATABASE_STATUS || 'RUNNING',
            databaseType: process.env.DATABASE_TYPE || 'neo4j',
            id: process.env.DATABASE_UUID || uuid.v4(),
            connection: {
                configuration: {
                    path: '.',
                    protocols: {
                        bolt: {
                            host,
                            port,
                            username,
                            password,
                            enabled: true,
                            tlsLevel: encryption,
                        },
                    },
                },
            },
        };
    }

    /**
     * Returns a promise that resolves to the HalinContext object completed,
     * or rejects.
     * 
     * There are three major code paths here:
     * (1) Running in Neo4j desktop, use that API to figure what graph to 
     * connect to.
     * (2) Running in browser (not desktop) -- in which case we needed to
     * fake the neo4j desktop API facade prior to this step
     * (3) Running in terminal (and window object isn't even defined)
     */
    initialize() {
        let inBrowser = true;
        try {
            // Will fail with ReferenceError if not in a browser.
            // eslint-disable-next-line
            const globalWindow = window;
        } catch (e) {
            inBrowser = false;
        }

        try {
            let getGraphSpecificsPromise = null;

            if (!inBrowser) {
                // No need to fake a neo4jdesktop API.  Construct
                // needed context directly from env vars.
                getGraphSpecificsPromise = Promise.resolve({
                    project: HalinContext.getProjectFromEnvironment(),
                    graph: HalinContext.getGraphFromEnvironment(),
                });
            } else {
                getGraphSpecificsPromise = nd.getFirstActive();
            }

            return getGraphSpecificsPromise.then(active => {
                    if (_.isNil(active)) {
                        // In the web version, this will never happen because the
                        // shim will fake an active DB.  In Neo4j Desktop this 
                        // **will** happen if the user launches Halin without an 
                        // activated database.
                        throw new Error('In order to launch Halin, you must have an active database connection');
                    }

                    // console.log('FIRST ACTIVE', active);
                    this.project = active.project;
                    this.graph = active.graph;

                    this.base = _.cloneDeep(active.graph.connection.configuration.protocols.bolt);

                    // Create a default driver to have around.
                    const uri = `bolt://${this.base.host}:${this.base.port}`;
                    this.base.driver = this.driverFor(uri);

                    // console.log('HalinContext created', this);
                    return Promise.all([
                        this.checkUser(this.base.driver),
                        this.checkForCluster(active),
                    ]);
                })
                .then(() => this)
        } catch (e) {
            console.error(e);
            return Promise.reject(new Error('General Halin Context error', e));
        }
    }

    /**
     * Ping a cluster node with a trivial query, just to keep connections
     * alive and verify it's still listening.  This forces driver creation
     * for a node if it hasn't already happened.
     * @param {ClusterNode} the node to ping
     * @returns {Promise} that resolves to an object with an elapsedMs field
     * or an err field populated.
     */
    ping(clusterNode) {
        const addr = clusterNode.getBoltAddress();
        const driver = this.driverFor(addr);

        // Gets or creates a ping data feed for this cluster node.
        // Data feed keeps running so that we can deliver the data to the user,
        // but also have a feed of data to know if the cord is getting unplugged
        // as the app runs.
        const pingFeed = this.getDataFeed(_.merge({
            node: clusterNode,
            driver,
        }, queryLibrary.PING));

        // Caller needs a promise.  The feed is already running, so 
        // We return a promise that resolves the next time the data feed
        // comes back with a result.
        return new Promise((resolve, reject) => {
            const onPingData = (newData, dataFeed) => {
                return resolve({
                    clusterNode,
                    elapsedMs: pingFeed.lastElapsedMs,
                    err: null,
                });
            };

            const onError = (err, dataFeed) => {
                console.error('HalinContext: failed to ping', addr, err);
                reject(err, dataFeed);
            };

            pingFeed.addListener(onPingData);
            pingFeed.onError = onError;
        });
    }

    /**
     * @param clusterNode{ClusterNode} 
     * @return Promise{Object} of diagnostic information about that node.
     */
    _nodeDiagnostics(clusterNode) {
        const basics = {
            basics: clusterNode.asJSON(),
        };

        const session = this.driverFor(clusterNode.getBoltAddress()).session();

        // Query must return 'value'
        const noFailCheck = (domain, query, key) =>
            session.run(query, {})
                .then(results => results.records[0].get('value'))
                .catch(err => err)  // Convert errors into the value.
                .then(value => {
                    const obj = {};
                    obj[domain] = {};
                    obj[domain][key] = value;
                    return obj;
                });

        // Format all JMX data into records.
        // Put the whole thing into an object keyed on jmx.
        const genJMX = session.run("CALL dbms.queryJmx('*:*')", {})
            .then(results =>
                results.records.map(rec => ({
                    name: rec.get('name'),
                    attributes: rec.get('attributes'),
                })))
            .then(array => ({ JMX: array }))

        const users = session.run('CALL dbms.security.listUsers()', {})
            .then(results =>
                results.records.map(rec => ({
                    username: rec.get('username'),
                    flags: rec.get('flags'),
                    roles: rec.get('roles'),
                })))
            .then(allUsers => ({ users: allUsers }));

        const roles = session.run('CALL dbms.security.listRoles()', {})
            .then(results =>
                results.records.map(rec => ({
                    role: rec.get('role'),
                    users: rec.get('users'),
                })))
            .then(allRoles => ({ roles: allRoles }));

        // Format node config into records.
        const genConfig = session.run('CALL dbms.listConfig()', {})
            .then(results => {
                const configMap = {};
                results.records.forEach(rec => {
                    const key = rec.get('name');
                    const value = rec.get('value');

                    // Configs can have duplicate keys!
                    // which sucks.  but we need to detect that.
                    // If a second value is found, push it on to an array.
                    if (configMap.hasOwnProperty(key)) {
                        const presentValue = configMap[key];
                        if (_.isArray(presentValue)) {
                            presentValue.push(value);
                        } else {
                            configMap[key] = [presentValue, value];
                        }
                    } else {
                        configMap[key] = value;
                    }
                });
                return configMap;
            })
            .then(allConfig => ({ configuration: allConfig }));

        const constraints = session.run('CALL db.constraints()', {})
            .then(results =>
                results.records.map((rec, idx) => ({ idx, description: rec.get('description') })))
            .then(allConstraints => ({ constraints: allConstraints }));

        const getOrNull = (rec, field) => {
            try {
                return rec.get(field);
            } catch (e) { return null; }
        };

        // Signature differs between 3.4 and 3.5, particularly
        // label field vs. tokenNames field.  getOrNull handles
        // both cases.
        const indexes = session.run('CALL db.indexes()', {})
            .then(results =>
                results.records.map((rec, idx) => ({
                    description: getOrNull(rec, 'description'),
                    label: getOrNull(rec, 'label'),
                    tokenNames: getOrNull(rec, 'tokenNames'),
                    properties: getOrNull(rec, 'properties'),
                    state: getOrNull(rec, 'state'),
                    type: getOrNull(rec, 'type'),
                    provider: getOrNull(rec, 'provider'),
                })))
            .then(allIndexes => ({ indexes: allIndexes }));

        const otherPromises = [
            noFailCheck('apoc', 'RETURN apoc.version() as value', 'version'),
            noFailCheck('nodes', 'MATCH (n) RETURN count(n) as value', 'count'),
            noFailCheck('schema', 'call db.labels() yield label return collect(label) as value', 'labels'),
            noFailCheck('algo', 'RETURN algo.version() as value', 'version'),
        ];

        return Promise.all([
            users, roles, indexes, constraints, genJMX, genConfig, ...otherPromises])
            .then(arrayOfDiagnosticObjects =>
                _.merge(basics, ...arrayOfDiagnosticObjects))
            .finally(() => session.close());
    }

    /**
     * @return Promise{Object} of halin diagnostics.
     */
    _halinDiagnostics() {
        const halin = {
            halin: {
                drivers: Object.keys(this.drivers).map(uri => ({
                    domain: `${this.domain}-driver`,
                    node: uri,
                    key: 'encrypted',
                    value: _.get(this.drivers[uri]._config, 'encrypted'),
                })),
                diagnosticsGenerated: moment.utc().toISOString(),
                activeProject: this.cleanup(this.project),
                activeGraph: this.cleanup(this.graph),
                dataFeeds: _.values(this.dataFeeds).map(df => df.stats()),
                ...appPkg,
            }
        };

        return Promise.resolve(halin);
    }

    /**
     * @return Promise{Object} of Neo4j Desktop API diagnostics.
     */
    _neo4jDesktopDiagnostics() {
        let api = null;

        try {
            api = window.neo4jDesktopApi;
        } catch (e) {
            // ReferenceError on missing window.
            api = null;
        }

        if (!api) {
            return Promise.resolve({ neo4jDesktop: 'MISSING' });
        }

        return api.getContext()
            .then(context => ({
                neo4jDesktop: this.cleanup(_.cloneDeep(context)),
            }));
    }

    /**
     * Run all diagnostics available to halin
     * @return Promise{Object} a large, heavyweight diagnostic object suitable for
     * analysis or shipping to the user.
     */
    runDiagnostics() {
        const allNodeDiags = Promise.all(this.clusterNodes.map(clusterNode => this._nodeDiagnostics(clusterNode)))
            .then(nodeDiagnostics => ({ nodes: nodeDiagnostics }));

        const halinDiags = this._halinDiagnostics();

        const neo4jDesktopDiags = this._neo4jDesktopDiagnostics();

        // Each object resolves to a diagnostic object with 1 key, and sub properties.
        // All diagnostics are just a merge of those objects.
        return Promise.all([halinDiags, allNodeDiags, neo4jDesktopDiags])
            .then(arrayOfObjects => _.merge(...arrayOfObjects))
    }
}