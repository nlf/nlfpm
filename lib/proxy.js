function Proxy(options) {
    this.options = options;
}

Proxy.prototype.showOptions = function () {
    return this.options;
};

module.exports = Proxy;
