import React, { Component } from 'react';
import { Menu, Icon, Popup } from 'semantic-ui-react'

export default class ClusterNodeTabHeader extends Component {
    state = {
        ratio: 1,
        total: 1,
        fresh: 1,
        notFresh: 0,
    };

    sampleFeeds() {
        if (!this.mounted) { return null; } 
        const feeds = window.halinContext.getFeedsFor(this.props.node).map(feed => feed.isFresh());

        const total = feeds.length;
        const fresh = feeds.filter(f => f).length;
        const notFresh = feeds.filter(f => !f).length;

        this.setState({ 
            ratio: fresh/total,
            total,
            fresh,
            notFresh,
        });
    }

    componentDidMount() {
        this.mounted = true;
        this.interval = setInterval(() => this.sampleFeeds(), 500);
    }

    componentWillUnmount() {
        this.mounted = false;
        clearInterval(this.interval);
    }

    colorFor = (ratio) => {
        if (ratio >= 0.8) { return 'green'; }
        if (ratio >= 0.6) { return 'yellow'; }
        return 'red';
    };

    popupContent = () => {
        return (
            <div className='PopupContent'>
                <h4>Data</h4>
                <p>{`${this.state.fresh} of ${this.state.total} fresh`}</p>

                <p>When most/all feeds are fresh, this indicates responsiveness.  When performance
                degrades, data feeds slow, stop, or error.</p>
            </div>
        );
    };

    statusIcon = () => {
        const node = this.props.node;

        const leader = `${node.role}`.toLowerCase() === 'leader';
        const replica = `${node.role}`.toLowerCase() === 'read_replica';

        let iconName;
        if(leader) { iconName = 'star'; }
        else if(replica) { iconName = 'copy'; }
        else { iconName = 'circle'; }  // Follower

        const color = this.colorFor(this.state.ratio);

        return (
            <Icon name={iconName} color={color} />
        );
    }

    render() {
        const node = this.props.node;

        return (
            <Menu.Item>
                <Popup
                    key={node.getBoltAddress()}
                    trigger={this.statusIcon()} 
                    header={node.role}
                    content={this.popupContent()}
                />
                 
                { node.getLabel() }
            </Menu.Item>
        );
    }
}