var Proxy = require('./lib/proxy');
var internals = {};

internals.index = function (request, reply) {
    reply(this.showOptions());
};

exports.register = function (plugin, options, next) {
    var nlfpm = plugin.select('nlfpm');
    var proxy = new Proxy(options);
    plugin.bind(proxy);

    nlfpm.route({
        method: 'GET',
        path: '/',
        handler: internals.index
    });

    next();
};
