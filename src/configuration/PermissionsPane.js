import React, { Component } from 'react';
import "semantic-ui-css/semantic.min.css";
import './PermissionsPane.css';
import { Grid, Message, Icon } from 'semantic-ui-react';
import Neo4jUsers from './users/Neo4jUsers';
import NewUserForm from './users/NewUserForm';

import Neo4jRoles from './roles/Neo4jRoles';
import NewRoleForm from './roles/NewRoleForm';
import uuid from 'uuid';

class PermsWarning extends Component {
    render() {
        return (
            <Message warning icon>
                <Icon name='warning' />
                <Message.Content>
                    Neo4j typically manages users on a per-machine basis.
                    <br/><strong color='red'>Features here will apply changes 
                    across all machines in your cluster</strong>.
                    <br/>To check if your users and roles are consistent across all of your machines,
                    run the advisor in the diagnostics area.
                </Message.Content>
            </Message>
        );
    }
}

class PermissionsPane extends Component {
    state = {
        key: uuid.v4(),
        childRefresh: 1,
    };

    event(name, data) {
        console.log('Permissions Event', name, data);
        this.setState({
            childRefresh: this.state.childRefresh + 1,
        })
    }

    render() {
        return (
            <div className="PermissionsPane">
                <Grid divided='vertically'>
                    { 
                        (window.halinContext && 
                         window.halinContext.clusterNodes && 
                         window.halinContext.clusterNodes.length > 1) ? 
                            <Grid.Row columns={1}>
                                <Grid.Column><PermsWarning/></Grid.Column>
                            </Grid.Row>
                        : ''
                    }

                    <Grid.Row columns={2}>
                        <Grid.Column>
                            <NewUserForm
                                key={this.state.key}
                                driver={this.props.driver}
                                node={this.props.node}
                                onUserCreate={username => this.event('user', username)} />
                        </Grid.Column>
                        <Grid.Column>
                            <NewRoleForm
                                key={this.state.key}
                                driver={this.props.driver}
                                node={this.props.node}
                                onRoleCreate={role => this.event('role', role)} />
                        </Grid.Column>
                    </Grid.Row>

                    <Grid.Row columns={2}>
                        <Grid.Column>
                            <Neo4jUsers
                                key={this.state.key}
                                driver={this.props.driver}
                                node={this.props.node}
                                refresh={this.state.childRefresh} />
                        </Grid.Column>
                        <Grid.Column>
                            <Neo4jRoles
                                key={this.state.key}
                                driver={this.props.driver}
                                node={this.props.node}
                                refresh={this.state.childRefresh} />
                        </Grid.Column>
                    </Grid.Row>

                    <Grid.Row columns={1}>
                        <Grid.Column>

                        </Grid.Column>
                    </Grid.Row>
                </Grid>
            </div>
        );
    }
}

export default PermissionsPane;