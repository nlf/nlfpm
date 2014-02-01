var hoek = require('hoek');
var nipple = require('nipple');
var redis = require('redis');
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var not_found = { error: 'not_found', reason: 'document not found' };

// just a quick key generator, note that we don't use args.join because we want
// to ignore 'undefined' values
function getKey(request) {
    var result = {};
    if (request.method === 'get') {
        if (request.params.package) {
            if (request.params.tarball) {
                // we have a tarball
                result.type = 'tarball';
                result.key = [request.params.package, request.params.tarball].join(':');
            } else {
                // we have metadata
                result.type = 'meta';
                result.key = request.params.package;
                if (request.params.version) {
                    result.key += ':' + request.params.version;
                }
            }
        } else if (request.path === '/') {
            result.type = 'index';
        } else {
            // we have a search
            result.type = 'search';
            result.key = 'search';
        }
    } else if (request.method === 'post') {
        // placeholder
        result.type = 'post';
        result.key = false;
    } else if (request.method === 'put') {
        // placeholder
        result.type = 'put';
        result.key = false;
    }

    return result;
}

// constructor
function Cache(options) {
    this.client = redis.createClient(options.redis.port, options.redis.host, options.redis.settings);
    this.path = options.path;
    this.registries = options.registries;
    this.private = (options.ssl ? 'https://' : 'http://') + this.registries.private;
    this.public = 'https://' + this.registries.public;
    mkdirp.sync(this.path);
}

// try to parse json, return an error object if it fails
function tryParse(data) {
    if (typeof data === 'object' && !Buffer.isBuffer(data)) return data;

    var result;
    
    try {
        result = JSON.parse(data);
    } catch (e) {
        result = { error: 'invalid_data', reson: 'unable to parse response' };
    }

    return result;
}

// transform data, if private is true it will swap public tarball urls for private ones
// and if it's false it does the opposite. because false is the opposite of true.
Cache.prototype._transform = function (data, private) {
    var result = tryParse(data);

    if (result.dist && result.dist.tarball) {
        if (private) {
            result.dist.tarball = result.dist.tarball.replace('http://' + this.registries.public, this.private);
        } else {
            result.dist.tarball = result.dist.tarball.replace(this.private, 'http://' + this.registries.public);
        }
    } else if (result.versions) {
        Object.keys(result.versions).forEach(function (version) {
            result.versions[version] = this._transform(result.versions[version], private);
        }.bind(this));
    }

    return result;
}

// cache results of a search request
Cache.prototype._cache_search = function (key, request, response, reply) {
    var cache = this;

    nipple.read(response, function (err, body) {
        if (!request.query.startkey) {
            return reply(body).code(response.statusCode);
        }

        parsed = tryParse(body);
        cache.client.hsetnx(key, parsed._updated, body);
        reply(parsed).code(response.statusCode);
    });
};

// serve cached search results
Cache.prototype._serve_search = function (key, request, response, reply) {
    var cache = this;
    var startkey = request.query.startkey;
    var deltakey, matchkeys, searchdoc;
    
    cache.client.hkeys(key, function (err, keys) {
        keys = keys.map(function (key) { return Number(key); }).sort();
        if (startkey) {
            // they requested a delta
            matchkeys = keys.filter(function (key) {
                return key >= startkey;
            });

            if (!matchkeys.length) {
                // we don't have anything newer than their requested start
                // so we just respond with the newest data we do have
                matchkeys = [keys[keys.length - 1]];
            }

            matchkeys.unshift('search');

        } else {
            // full response
            matchkeys = ['search'].concat(keys);
        }
        cache.client.hmget(matchkeys, function (err, result) {
            searchdoc = {};
            result.forEach(function (doc) {
                searchdoc = hoek.merge(searchdoc, JSON.parse(doc));
            });
            reply(searchdoc).code(200);
        });
    });
};

// cache metadata
Cache.prototype._cache_meta = function (key, request, response, reply) {
    var cache = this;

    if (response.statusCode === 304) {
        return reply(null).code(response.statusCode).header('Etag', response.headers.etag);
    }

    nipple.read(response, function (err, body) {
        body = cache._transform(body, true);
        cache.client.get(key + ':etag', function (err, etag) {
            if (etag !== response.headers.etag) {
                cache.client.set(key, JSON.stringify(body));
                cache.client.set(key + ':etag', response.headers.etag);
            }

            reply(body).code(response.statusCode).header('Etag', response.headers.etag);
        });
    });
};

// serve cached metadata
Cache.prototype._serve_meta = function (key, request, response, reply) {
    var cache = this;

    cache.client.get(key, function (err, meta) {
        if (err || !meta) {
            return reply(not_found).code(404);
        }

        cache.client.get(key + ':etag', function (err, etag) {
            if (err || !etag) {
                return reply(not_found).code(404);
            }

            if (etag === request.headers['if-none-match']) {
                return reply(null).code(304).header('Etag', etag);
            }

            meta = tryParse(meta);
            reply(meta).code(200).header('Etag', etag);
        });
    });
};

// cache tarball
Cache.prototype._cache_tarball = function (key, request, response, reply) {
    var cache = this;
    var filename, output;

    if (response.statusCode === 304) {
        return reply(null).code(response.statusCode).header('Etag', response.headers.etag);
    }
    
    response.pause();
    cache.client.get(key + ':etag', function (err, etag) {
        filename = path.join(cache.path, request.params.tarball);
        if (etag !== response.headers.etag) {
            output = fs.createWriteStream(filename);
            output.on('finish', function () {
                cache.client.set(key, filename);
                cache.client.set(key + ':etag', response.headers.etag);
                reply(fs.createReadStream(filename)).code(response.statusCode).header('Etag', response.headers.etag);
            });
            response.pipe(output);
            response.resume();
        } else {
            response.resume();
            reply(fs.createReadStream(filename)).code(response.statusCode).header('Etag', response.headers.etag);
        }
    });
};

// serve cached tarball
Cache.prototype._serve_tarball = function (key, request, response, reply) {
    var cache = this;

    cache.client.get(key, function (err, filename) {
        if (err || !filename) {
            return reply(not_found).code(404);
        }

        cache.client.get(key + ':etag', function (err, etag) {
            if (err || !etag) {
                return reply(not_found).code(404);
            }

            if (etag === request.headers['if-none-match']) {
                return reply(null).code(304).header('Etag', etag);
            }

            reply(fs.createReadStream(filename)).code(200).header('Etag', etag);
        });
    });
};

// determine what the request is, and if we were able to reach the upstream
// then call the appropriate handler
Cache.prototype.handler = function (request, reply, response) {
    var data = getKey(request);

    if (response.isBoom) {
        this['_serve_' + data.type](data.key, request, response, reply);
    } else {
        this['_cache_' + data.type](data.key, request, response, reply);
    }
};

// this one makes sure we transform the payload back to using public urls and
// passes through everything else to allow publishes to work
Cache.prototype.putHandler = function (request, reply) {
    var cache = this;
    var payload = JSON.stringify(cache._transform(request.payload, false));
    var url = 'https://' + cache.registries.public + request.path;
    var headers = {
        'content-type': 'application/json',
        'content-length': payload.length,
        accept: 'application/json',
        cookie: request.headers.cookie
    };

    nipple.request('put', url, { headers: headers, payload: payload }, function (err, res) {
        if (err) {
            return reply(err);
        }

        reply(res).code(res.statusCode);
    });
};

// see if the search cache is primed, and prime it if it's not
// this takes a bit. we do it here instead of waiting for a request
// to make sure that at least one member of the search hash contains
// the *full* search data, otherwise we'll definitely be missing a lot
Cache.prototype.primeSearch = function (plugin, callback) {
    var cache = this;

    plugin.log(['info', 'nlfpm'], 'Checking for search cache...');
    cache.client.exists('search', function (err, exists) {
        if (exists) {
            plugin.log(['info', 'nlfpm'], 'Search cache found, completing startup');
            return callback();
        }

        plugin.log(['info', 'nlfpm'], 'Search cache not found, attempting to prime it...');
        nipple.request('get', 'https://' + cache.registries.public + '/-/all', {}, function (err, res) {
            if (err) {
                throw err;
            }
            nipple.read(res, function (err, body) {
                if (err) {
                    throw err;
                }

                var parsed = JSON.parse(body);
                cache.client.hset('search', parsed._updated, body, function (err, result) {
                    parsed = undefined;
                    if (err) {
                        throw err;
                    }
                    plugin.log(['info', 'nlfpm'], 'Search cache primed, completing startup');
                    callback();
                });
            });
        });
    });
};

module.exports = Cache;
