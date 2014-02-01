var Hoek = require('hoek');
var Proxy = require('./lib/proxy');
var internals = {};
var not_found = { error: 'not_found', reason: 'document not found' };

internals.indexFailed = function (request, reply, err, settings) {
    reply(not_found).code(404);
};

internals.getMeta = function (request, reply) {
    this.getMeta(request.params.package, request.params.version, request.headers['if-none-match'], function (data, code, etag) {
        reply(data).code(code).header('Etag', etag);
    });
};

internals.getTarball = function (request, reply) {
    if (!request.params.tarball.match(/\.tgz$/)) {
        this.getMeta(request.params.package, request.params.version, request.params.tarball, request.query, request.headers['if-none-match'], function (data, code, etag) {
            reply(data).code(code).header('Etag', etag);
        });
    } else {
        this.getData(request.params.package, request.params.tarball, request.headers['if-none-match'], function (stream, code, etag) {
            reply(stream).code(code).header('Etag', etag);
        });
    }
};

exports.register = function (plugin, options, next) {
    var assert, nlfpm, proxy;

    // validate our options
    Hoek.assert(typeof options.registries === 'object', 'Registries option must be an object');
    Hoek.assert(typeof options.registries.public === 'string', 'Public registry option must be a string');
    Hoek.assert(typeof options.registries.private === 'string', 'Private registry option must be a string');
    Hoek.assert(options.hasOwnProperty('ssl') && typeof options.ssl === 'boolean', 'SSL option must be a boolean');
    Hoek.assert(typeof options.cache === 'object', 'Cache option must be an object');
    Hoek.assert(typeof options.cache.redis === 'object', 'Redis option must be an object');
    Hoek.assert(typeof options.cache.redis.host === 'string', 'Redis host option must be a string');
    Hoek.assert(typeof options.cache.redis.port === 'number', 'Redis port options must be a number');

    // create a new proxy object and bind it to our routes
    proxy = new Proxy(options);
    plugin.bind(proxy);

    // select the 'nlfpm' tag in case someone is using this server for more than one thing
    nlfpm = plugin.select('nlfpm');

    // add our routes
    nlfpm.route({
        method: 'GET',
        path: '/',
        handler: {
            proxy: {
                host: options.registries.public,
                port: 443,
                protocol: 'https',
                passThrough: true,
                failureResponse: internals.indexFailed
            }
        }
    });

    nlfpm.route({
        method: 'GET',
        path: '/{package}/{version?}',
        handler: internals.getMeta
    });

    nlfpm.route({
        method: 'GET',
        path: '/{package}/{version}/{tarball}',
        handler: internals.getTarball
    });

    nlfpm.route({
        method: 'POST',
        path: '/{params*}',
        handler: {
            proxy: {
                host: options.registries.public,
                port: 443,
                protocol: 'https',
                passThrough: true
            }
        }
    });

    // nlfpm.route({
    //     method: 'PUT',
    //     path: '/{params*}',
    //     handler: {
    //     }
    // });

    next();
};
