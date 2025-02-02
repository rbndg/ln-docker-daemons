const asyncAuto = require('async/auto');
const asyncEach = require('async/each');
const asyncMap = require('async/map');
const asyncRetry = require('async/retry');
const {authenticatedLndGrpc} = require('lightning');
const {createChainAddress} = require('lightning');
const {findFreePorts} = require('find-free-ports');
const {getUtxos} = require('lightning');
const {getIdentity} = require('lightning');
const {returnResult} = require('asyncjs-util');

const {spawnLightningDocker} = require('./../lnd');

const between = (min, max) => Math.floor(Math.random() * (max - min) + min);
const chunk = (arr, n, size) => [...Array(size)].map(_ => arr.splice(0, n));
const count = size => size || 1;
const endPort = 65000;
const generateAddress = '2N8hwP1WmJrFF5QWABn38y63uYLhnJYJYTF';
const interval = 10;
const makeAddress = ({lnd}) => createChainAddress({lnd});
const maturity = 100;
const pairs = n => n.map((x, i) => n.slice(i + 1).map(y => [x, y])).flat();
const portsPerLnd = 6;
const startPort = 1025;
const times = 3000;

/** Spawn a cluster of nodes

  {
    [lnd_configuration]: [<LND Configuration Argument String>]
    [size]: <Total Lightning Nodes Number>
  }

  @returns via cbk or Promise
  {
    nodes: [{
      generate: <Make Block Function> ({address, count}, [cbk]) => {}
      id: <Node Public Key Hex String>
      kill: <Kill Function> ({}, cbk) => {}
      lnd: <Authenticated LND API Object>
      rpc: <RPC Connection Function> ({macaroon}) => {}
      socket: <Node Socket String>
    }]
  }
*/
module.exports = (args, cbk) => {
  return new Promise((resolve, reject) => {
    return asyncAuto({
      // Spawn nodes
      spawn: async () => {
        return await asyncRetry({interval, times: 25}, async () => {
          const options = {startPort: between(startPort, endPort)};

          // Find ports for the requested daemons
          const findPorts = await findFreePorts(
            portsPerLnd * count(args.size),
            options
          );

          const nodes = chunk(findPorts, portsPerLnd, count(args.size));

          return await asyncMap(nodes, async (ports) => {
            const [
              chainP2pPort,
              chainRpcPort,
              chainZmqBlockPort,
              chainZmqTxPort,
              lightningP2pPort,
              lightningRpcPort,
            ] = ports;

            const lightningDocker = await spawnLightningDocker({
              chain_p2p_port: chainP2pPort,
              chain_rpc_port: chainRpcPort,
              chain_zmq_block_port: chainZmqBlockPort,
              chain_zmq_tx_port: chainZmqTxPort,
              generate_address: generateAddress,
              lightning_p2p_port: lightningP2pPort,
              lightning_rpc_port: lightningRpcPort,
              lnd_configuration: args.lnd_configuration,
            });
            const {lnd} = authenticatedLndGrpc({
              cert: lightningDocker.cert,
              macaroon: lightningDocker.macaroon,
              socket: lightningDocker.socket,
            });

            const id = (await getIdentity({lnd})).public_key;

            return {
              id,
              lnd,
              chain: {
                addPeer: lightningDocker.add_chain_peer,
                generateToAddress: lightningDocker.generate,
                getBlockInfo: lightningDocker.get_block_info,
                socket: lightningDocker.chain_socket,
              },
              generate: ({address, count}) => {
                return new Promise(async (resolve, reject) => {
                  await lightningDocker.generate({
                    count,
                    address: address || (await makeAddress({lnd})).address,
                  });

                  if (!count || count < maturity) {
                    return resolve();
                  }

                  await asyncRetry({interval, times}, async () => {
                    const [utxo] = (await getUtxos({lnd})).utxos;

                    if (!utxo) {
                      throw new Error('ExpectedUtxoInUtxos');
                    }

                    return utxo;
                  });

                  return resolve();
                });
              },
              kill: lightningDocker.kill,
              public_key: id,
              rpc: ({macaroon}) => {
                const {lnd} = authenticatedLndGrpc({
                  macaroon,
                  cert: lightningDocker.cert,
                  socket: lightningDocker.socket,
                });

                return {lnd};
              },
              rpc_socket: lightningDocker.socket,
              socket: lightningDocker.ln_socket,
              macaroon: lightningDocker.macaroon,
              cert: lightningDocker.cert,
            };
          });
        });
      },

      // Connect nodes in the cluster to each other
      connect: ['spawn', async ({spawn}) => {
        return await asyncEach(pairs(spawn), async pair => {
          const [a, b] = pair.map(({chain}) => chain);

          return await a.addPeer({socket: b.socket});
        });
      }],

      // Final set of nodes
      nodes: ['connect', 'spawn', async ({spawn}) => {
        return {
          kill: ({}) => asyncEach(spawn, async ({kill}) => await kill({})),
          nodes: spawn.map(node => ({
            generate: node.generate,
            id: node.id,
            kill: node.kill,
            lnd: node.lnd,
            rpc: node.rpc,
            socket: node.socket,
            rpc_socket:node.rpc_socket,
            macaroon: node.macaroon,
            cert: node.cert,
          })),
        };
      }],
    },
    returnResult({reject, resolve, of: 'nodes'}, cbk));
  });
};
