import Ring from 'ringjs';
import { TimeEvent } from "pondjs";

const neo4j = require("neo4j-driver/lib/browser/neo4j-web.min.js").v1;

/**
 * DataFeed is an abstraction that polls a cypher query
 * against a driver in a configurable way, and can happen
 * in the background independent of a component being 
 * mounted or not mounted.  
 */
export default class DataFeed {
    constructor(props) {
        this.node = props.node;
        this.driver = props.driver;
        this.query = props.query;
        this.params = props.params || {};
        this.rate = props.rate || 1000;
        this.displayColumns = props.displayColumns;
        this.windowWidth = props.windowWidth || (1000 * 60 * 7);

        this.state = {
            data: null,
            events: new Ring(Math.floor((this.windowWidth / this.rate) * 1.25)),
            time: new Date(),
            lastDataArrived: new Date(),
        };

        this.onData = props.onData || (() => null);

        if (!this.node || !this.driver || !this.query || !this.displayColumns) {
            throw new Error('Missing one of required props displayColumns, node, driver, query');
        }

        this.name = `${this.node.getBoltAddress()}-${this.query}}`;
    }

    currentState() {
        return this.state;
    }

    stop() {
        if (this.timeout) {
            clearTimeout(this.timeout);
        }
    }

    start() {
        this.stop();
        return this.sampleData();
    }

    /**
     * Get the minmum value that occurs in the feed.
     */
    min() {
        if (!this.state.data || this.state.data.length === 0) { return 0; }
        const minObs = obs => Math.min(...Object.values(obs));

        const allMins = this.state.data.map(obs => minObs(obs));
        return Math.min(...allMins);
    }

    /**
     * Get the maximum value that occurs in the feed.
     */
    max() {
        if (!this.state.data || this.state.data.length === 0) { return 1; }
        const maxObs = obs => Math.max(...Object.values(obs));

        const allMaxes = this.state.data.map(obs => maxObs(obs));
        return Math.max(...allMaxes);
    }

    sampleData() {
        const session = this.driver.session();
        const startTime = new Date().getTime();

        return session.run(this.query, this.params)
            .then(results => {
                const elapsedMs = new Date().getTime() - startTime;

                if (elapsedMs > this.rate) {
                    // It's a bad idea to run long-running queries with a short window.
                    // It puts too much load on the system and does a bad job updating the
                    // graphic.
                    console.warn('DataFeed query is taking a lot of time relative to your execution window.  Consider adjusting', {
                        elapsedMs, addr: this.node.getBoltAddress(),
                    });
                }

                // Take the first result only.  This component only works with single-record queries.
                const rec = results.records[0];
                const data = {};

                // Plug query data values into data map, converting ints as necessary.
                this.displayColumns.forEach(col => {
                    const val = rec.get(col.accessor);
                    data[col.accessor] = neo4j.isInt(val) ? neo4j.integer.toNumber(val) : val;
                })

                this.timeout = setTimeout(() => this.sampleData(), this.rate);

                const t = new Date();
                const event = new TimeEvent(t, data);
                const newEvents = this.state.events;
                newEvents.push(event);
                this.state.lastDataArrived = new Date();
                this.state.data = [data];
                this.state.time = t;
                this.state.event = newEvents;

                // Let our user know we have something new.
                return this.onData(this.state, this);
            })
            .catch(err => {
                console.error('Failed to execute timeseries query', err);
            })
            .finally(() => session.close());
    }
}