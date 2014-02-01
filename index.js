var Hoek = require('hoek');
var Cache = require('./lib/cache');

exports.register = function (plugin, options, next) {
    var nlfpm, cache;

    // validate our options
    Hoek.assert(typeof options.registries === 'object', 'Registries option must be an object');
    Hoek.assert(typeof options.registries.public === 'string', 'Public registry option must be a string');
    Hoek.assert(typeof options.registries.private === 'string', 'Private registry option must be a string');
    Hoek.assert(options.hasOwnProperty('ssl') && typeof options.ssl === 'boolean', 'SSL option must be a boolean');
    Hoek.assert(typeof options.redis === 'object', 'Redis option must be an object');
    Hoek.assert(typeof options.redis.host === 'string', 'Redis host option must be a string');
    Hoek.assert(typeof options.redis.port === 'number', 'Redis port options must be a number');
    Hoek.assert(typeof options.path === 'string', 'Path option must be a string');

    plugin.log(['info', 'nlfpm'], 'Starting nlfpm..');

    // create a new cache object and bind it to our routes
    cache = new Cache(options);
    plugin.bind(cache);

    // select the 'nlfpm' tag in case someone is using this server for more than one thing
    nlfpm = plugin.select('nlfpm');

    var defaultHandler = {
        host: options.registries.public,
        port: 443,
        protocol: 'https',
        passThrough: true,
    };

    var cacheHandler = Hoek.applyToDefaults(defaultHandler, { postResponse: cache.handler });

    // add our routes
    nlfpm.route({
        method: 'GET',
        path: '/{package}/{version?}',
        handler: {
            proxy: cacheHandler
        }
    });

    nlfpm.route({
        method: 'GET',
        path: '/{package}/-/{tarball}',
        handler: {
            proxy: cacheHandler
        }
    });

    nlfpm.route({
        method: 'GET',
        path: '/-/all/{extra?}',
        handler: {
            proxy: cacheHandler
        }
    });

    nlfpm.route({
        method: 'POST',
        path: '/{params*}',
        handler: {
            proxy: defaultHandler
        }
    });

    nlfpm.route({
        method: 'PUT',
        path: '/{params*}',
        handler: cache.putHandler,
        config: {
            payload: {
                allow: 'application/json'
            }
        }
    });

    cache.primeSearch(plugin, next);
};
