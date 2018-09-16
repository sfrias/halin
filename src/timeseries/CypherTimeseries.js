import React, { Component } from 'react';
import _ from 'lodash';
import 'semantic-ui-css/semantic.min.css';
import { Grid } from 'semantic-ui-react';
import * as PropTypes from "prop-types";
import {
    TimeSeries,
    TimeRange,
    TimeEvent,
    Stream,
} from "pondjs";

import { styler, Charts, Legend, ChartContainer, ChartRow, YAxis, LineChart } from 'react-timeseries-charts';
import Ring from 'ringjs';

const neo4j = require("neo4j-driver/lib/browser/neo4j-web.min.js").v1;

const DEFAULT_PALETTE = [
    '#f68b24', 'steelblue', '#619F3A', '#dfecd7', 
];

/**
 * Repeatedly executes the same cypher query in a loop on a given timeline,
 * and updates a timeseries chart.
 */
class CypherTimeseries extends Component {
    state = {
        query: null,
        data: null,
        events: null,
        time: new Date(),
        lastDataArrived: new Date(),
        disabled: {},
    };

    constructor(props, context) {
        super(props, context);
        this.driver = props.driver || context.driver;

        if (!props.query) {
            throw new Error('query is required');
        } else if (!props.displayColumns) {
            throw new Error('displayColumns is required');
        }

        this.query = props.query;
        this.rate = props.rate || 1000;
        this.width = props.width || 800;
        this.min = props.min || (data => this.adjustableMin(data));
        this.max = props.max || (data => this.adjustableMax(data));
        this.timeWindowWidth = props.timeWindowWidth || 1000 * 60 * 5;  // 5 min
        this.displayColumns = props.displayColumns;
        this.palette = props.palette || DEFAULT_PALETTE;
        this.showGrid = _.isNil(props.showGrid) ? false : props.showGrid;
        this.showGridPosition = _.isNil(props.showGridPosition) ? 'over' : props.showGridPosition;

        // By default, enable only those specified, otherwise all are on by default.
        this.startingEnabled = props.startingEnabled || props.displayColumns;

        this.dateStyle = {
            fontSize: 12,
            color: "#AAA",
            borderWidth: 1,
            borderColor: "#F4F4F4"
        };

        this.maxObservedValue = -Infinity;
        this.minObservedValue = Infinity;
    }

    // Compute min of Y axis when user hasn't told us value range.
    adjustableMin(obj) {
        const values = Object.values(obj);
        const computedMin = Math.min(...values) * 0.9;

        if (computedMin < this.minObservedValue) {
            this.minObservedValue = computedMin;
        }

        return Math.min(computedMin, this.minObservedValue);
    };
    
    // Compute max of Y axis when user hasn't told us value range.
    adjustableMax(obj) {
        const values = Object.values(obj);
        const computedMax = Math.max(...values) * 1.1;

        if (computedMax > this.maxObservedValue) {
            this.maxObservedValue = computedMax;
        }

        return Math.max(computedMax, this.maxObservedValue);
    };
    
    componentDidMount() {
        this.mounted = true;

        const disabled = {};

        this.displayColumns.forEach((col, idx) => {
            let disabledFlag;

            if (this.startingEnabled.filter(i => i.accessor === col.accessor).length > 0) {
                disabledFlag = false;
            } else {
                disabledFlag = true;
            }

            disabled[idx] = disabledFlag;
        });

        // Ring buffer captures all of the data that gets displayed. 
        // Can't keep everything, but we need a ring big enough to get as many samples
        // as the time window is wide.  I'm arbitrarily adding 25% just so we don't miss
        // data.

        this.setState({ 
            disabled,
            events: new Ring(Math.floor((this.timeWindowWidth / this.rate) * 1.25)),
        });
        this.stream = new Stream();

        this.sampleData();
    }

    componentWillUnmount() {
        this.mounted = false;
        if (this.interval) {
            clearInterval(this.interval);
        }
    }

    sampleData() {
        const session = this.driver.session();

        const startTime = new Date().getTime();

        return session.run(this.query, this.state.parameters || {})
            .then(results => {
                const elapsedMs = new Date().getTime() - startTime;

                if (elapsedMs > (this.rate / 2)) {
                    // It's a bad idea to run long-running queries with a short window.
                    // It puts too much load on the system and does a bad job updating the
                    // graphic.
                    console.warn('CypherTimeseries query is taking a lot of time relative to your execution window.  Consider adjusting', this);
                }

                // Take the first result only.  This component only works with single-record queries.
                const rec = results.records[0];
                const data = {};

                // Plug query data values into data map, converting ints as necessary.
                this.displayColumns.forEach(col => {
                    const val = rec.get(col.accessor);
                    data[col.accessor] = neo4j.isInt(val) ? neo4j.integer.toNumber(val) : val;
                })

                if (this.mounted) {
                    this.timeout = setTimeout(() => this.sampleData(), this.rate);

                    const t = new Date();
                    const event = new TimeEvent(t, data);
                    const newEvents = this.state.events;
                    newEvents.push(event);
                    this.setState({
                        lastDataArrived: new Date(),
                        data: [data],
                        time: t,
                        event: newEvents
                    });
                }
            })
            .catch(err => {
                console.error('Failed to execute timeseries query', err);
            })
            .finally(() => session.close());
    }

    getChartMin() {
        let min;

        if (_.isFunction(this.min)) {        
            min = this.min(this.state.data[0]);
        } else {
            min = this.min;
        }

        return min;
    }

    getChartMax() {
        let max;
        if (_.isFunction(this.max)) {
            max = this.max(this.state.data[0]);
        } else {
            max = this.max;
        }

        return max;
    }

    chooseColor(idx) {
        if (_.isNil(idx)) {
            return this.palette[0];
        }

        if (this.state.disabled[idx]) {
            return 'transparent';
        }

        return this.palette[idx % this.palette.length];
    }

    legendClick = data => {
        console.log('Legend clicked',data);

        // Find index and toggle its disabled state.
        let foundIdx;

        this.displayColumns.forEach((item, idx) => {            
            if (item.accessor === data) {
                foundIdx = idx;
            }
        });
        
        const toggle = idx => {
            const disabledNew = _.cloneDeep(this.state.disabled);
            disabledNew[idx] = !this.state.disabled[idx];
            this.setState({ disabled: disabledNew });
        };

        toggle(foundIdx);
        // console.log('disabled',this.state.disabled);
    };

    render() {
        if (!this.state.events) { return 'Loading...'; }
        const style = styler(this.displayColumns.map((col, idx) => ({
            key: col.accessor, 
            color: this.chooseColor(idx),
            width: 3,
        })));

        const dataSeries = new TimeSeries({
            name: "Data Series",
            events: this.state.events.toArray(),
        });

        const timeRange = new TimeRange(
            new Date(this.state.time.getTime() - (this.timeWindowWidth)),
            new Date(this.state.time.getTime() + (30 * 1000))
        );

        return this.state.data ? (
            <div className="CypherTimeseries">
                {/* <ReactTable
                    data={this.state.data}
                    sortable={false}
                    filterable={false}
                    showPagination={false}
                    defaultPageSize={1}
                    columns={this.displayColumns} /> */}

                <Grid divided='vertically'>
                    <Grid.Row columns={1}>
                        <Grid.Column>
                            <Legend type="swatch"
                                style={style}
                                onSelectionChange={this.legendClick}
                                categories={this.displayColumns.map((col, idx) => ({
                                    key: col.accessor,
                                    label: col.Header || col.accessor,
                                    style: { fill: this.chooseColor(idx) },
                                }))}
                            />
                        </Grid.Column>
                        {/* <Grid.Column>
                            <span style={this.dateStyle}>{`${this.state.time}`}</span>
                        </Grid.Column> */}
                    </Grid.Row>
                    <ChartContainer 
                        showGrid={this.showGrid}
                        showGridPosition={this.showGridPosition}
                        width={this.width} 
                        timeRange={timeRange}>
                        <ChartRow height="150">
                            <YAxis id="y" 
                                min={this.getChartMin()} 
                                max={this.getChartMax()} 
                                width="70" 
                                showGrid={true}
                                type="linear"/>
                            <Charts>
                                {
                                    this.displayColumns.map((col, idx) => 
                                        <LineChart key={`ct-${idx}`}
                                            axis="y" 
                                            style={style} 
                                            columns={[col.accessor]}
                                            series={dataSeries}
                                            />
                                    )
                                }
                            </Charts>
                        </ChartRow>
                    </ChartContainer>
                </Grid>
            </div>
        ) : 'Loading...';
    }
}

CypherTimeseries.contextTypes = {
    driver: PropTypes.object,
};

export default CypherTimeseries;