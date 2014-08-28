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

    nlfpm.ext('onPreResponse', function (request, next) {
        if (request.response.message) {
            request.response.reason = request.response.message;
        }

        next();
    });

    // add our routes
    nlfpm.route({
        method: 'GET',
        path: '/{package}/{version?}',
        handler: cache.handler
    });

    nlfpm.route({
        method: 'GET',
        path: '/{package}/-/{tarball}',
        handler: cache.handler
    });

    nlfpm.route({
        method: 'GET',
        path: '/-/all/{extra?}',
        handler: cache.handler
    });

    nlfpm.route({
        method: 'PUT',
        path: '/_private/{package}',
        handler: cache.privatePutHandler,
        config: {
            payload: {
                allow: 'application/json'
            }
        }
    });

    nlfpm.route({
        method: 'PUT',
        path: '/{package}',
        handler: cache.putHandler,
        config: {
            payload: {
                allow: 'application/json'
            }
        }
    });

    nlfpm.route({
        method: 'PUT',
        path: '/{package}/-rev/{revid}',
        handler: cache.putRevHandler
    });

    nlfpm.route({
        method: ['GET', 'PUT'],
        path: '/-/user/{user}/{extra*}',
        handler: {
            proxy: {
                host: options.registries.public,
                port: 443,
                protocol: 'https',
                passThrough: true
            }
        }
    });

    nlfpm.route({
        method: 'DELETE',
        path: '/{package}/-/{tarball}/-rev/{version}',
        handler: cache.deleteHandler
    });

    cache.primeSearch(plugin, next);
};

exports.register.attributes = {
    pkg: require('./package.json')
};
