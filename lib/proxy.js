var Hoek = require('hoek');
var Cache = require('./cache');
var nipple = require('nipple');
var querystring = require('querystring');

var not_found = { error: 'not_found', reason: 'document not found' };

// try to parse json, return an error if it fails
function tryParse(data) {
    var result;

    try {
        result = JSON.parse(data);
    } catch (e) {
        result = { error: 'invalid', reason: 'unable to parse response' };
    }

    return result;
}

// constructor
function Proxy(options) {
    this.options = options;
    this.private = (this.options.ssl ? 'https://' : 'http://') + this.options.registries.private;
    this.public = 'https://' + this.options.registries.public;
    this.cache = new Cache(options.cache);
}

// generate a url given some parameters
Proxy.prototype._buildUrl = function () {
    var url = this.public;
    var query;

    var args = Array.prototype.slice.call(arguments);

    if (args.length === 4) {
        query = querystring.stringify(args.pop());
    }

    args.forEach(function (arg) {
        if (arg) {
            url += '/' + arg;
        }
    });

    if (query) {
        url += '?' + query;
    }

    return url;
}

// transform data, if private is true it will swap public tarball urls for private ones
// and if it's false it does the opposite. because false is the opposite of true.
Proxy.prototype._transform = function (data, private) {
    var result = Hoek.clone(data);

    if (result.dist && result.dist.tarball) {
        if (private) {
            result.dist.tarball = result.dist.tarball.replace('http://' + this.options.registries.public, this.private);
        } else {
            result.dist.tarball = result.dist.tarball.replace(this.private, 'http://' + this.options.registries.public);
        }
    } else if (result.versions) {
        Object.keys(result.versions).forEach(function (version) {
            result.versions[version] = this._transform(result.versions[version], private);
        }.bind(this));
    }

    return result;
}

// fetch things that we're expect json from
Proxy.prototype.getMeta = function (package, version, extra, query, etag, callback) {
    if (arguments.length === 4) {
        callback = query;
        etag = extra;
        extra = undefined;
        query = undefined;
    }

    var proxy = this;
    var new_etag, url;
    var done = false;

    url = proxy._buildUrl(package, version, extra, query);

    nipple.request('get', url, {}, function (err, res) {
        if (err || res.statusCode >= 500) {
            proxy.cache.getMeta(package, version, function (meta, new_etag) {
                if (!meta) {
                    return callback(not_found, 404);
                }

                if (new_etag === etag) {
                    callback(null, 304, etag);
                } else {
                    callback(meta, 200, new_etag);
                }
            });
            return;
        }

        new_etag = res.headers.etag;
        if (new_etag === etag) {
            callback(null, 304, etag);
            done = true;
        }

        res.pause();
        proxy.cache.exists(package, version, new_etag, function (err, exists) {
            if (exists && done) {
                res.end();
                return;
            }

            res.resume();
            nipple.read(res, function (err, body) {
                if (err) return callback(err, 500);

                body = tryParse(body);
                if (body.error) {
                    if (!done) {
                        callback(body, 500);
                    }
                } else {
                    if (!done) {
                        body = proxy._transform(body, true);
                        proxy.cache.saveMeta(package, version, new_etag, body);
                        callback(body, 200, new_etag);
                    }
                }
            });
        });
    });
};

// fetch things we're expecting a tarball from
Proxy.prototype.getData = function (package, tarball, etag, callback) {
    var new_etag, url;
    var proxy = this;
    var done = false;

    url = proxy._buildUrl(package, '-', tarball);

    nipple.request('get', url, {}, function (err, res) {
        if (err || res.statusCode >= 500) {
            proxy.cache.getData(package, tarball, function (stream, new_etag) {
                if (!stream) {
                    return callback(not_found, 404);
                }

                if (new_etag == etag) {
                    callback(null, 304, etag);
                    stream.end();
                } else {
                    callback(stream, 200, new_etag);
                }
            });
            return;
        }

        new_etag = res.headers.etag;
        if (new_etag === etag) {
            callback(null, 304, etag);
            done = true;
        }

        // pause the stream in this tick so we don't lose data
        // it gets resumed in the saveData method of the cache
        res.pause();
        proxy.cache.exists(package, tarball, new_etag, function (err, exists) {
            if (exists && done) {
                res.end();
                return;
            }

            proxy.cache.saveData(package, tarball, new_etag, res);
            callback(res, 200, new_etag);
        });
    });
};

module.exports = Proxy;
