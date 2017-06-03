var webpack = require('webpack');
var path = require('path');

var CommonsChunkPlugin = require("webpack/lib/optimize/CommonsChunkPlugin");
var HtmlWebpackPlugin = require('html-webpack-plugin');

var npmDir = path.join(__dirname, 'node_modules');

module.exports = {
    entry: {
        sparql: path.join(__dirname, 'src', 'examples', 'sparql.ts'),
    },
    resolve: {
        extensions: ['', '.ts', '.tsx', '.webpack.js', '.web.js', '.js'],
        alias: {
            // Backbone provided by joint.js, to prevent module duplication which
            // causes errors when Ontodia uses Backbone models from joint.js
            'backbone': path.join(npmDir, 'backbone', 'backbone.js'),
            // awful and temporary workaround to reference browser bundle instead of node's, see:
            // https://github.com/wycats/handlebars.js/issues/1102
            'handlebars': path.join(npmDir, 'handlebars', 'dist', 'handlebars.min.js'),
        },
    },
    module: {
        loaders: [
            {test: /\.ts$|\.tsx$/, loader: 'ts-loader'},
            {test: /\.css$/, loader: 'style-loader!css-loader'},
            {test: /\.scss$/, loader: 'style-loader!css-loader!sass-loader'},
            {test: /\.jpe?g$/, loader: 'url-loader?mimetype=image/jpeg'},
            {test: /\.gif$/, loader: 'url-loader?mimetype=image/gif'},
            {test: /\.png$/, loader: 'url-loader?mimetype=image/png'},
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            filename: 'sparql.html',
            title: 'Ontodia SparQL',
            chunks: ['commons', 'sparql'],
            template: path.join(__dirname, 'src', 'examples', 'template.ejs'),
        }),
        new CommonsChunkPlugin('commons', 'commons.chunk.js'),
    ],
    output: {
        path: path.join(__dirname, 'dist', 'examples'),
        filename: '[name].bundle.js',
        chunkFilename: '[id].chunk.js',
        publicPath: '/',
    },
    devtool: '#source-map',
    devServer: {
        proxy: {
            "/sparql-endpoint": {
                target: process.env.SPARQL_ENDPOINT,
                ignorePath: true,
                changeOrigin: true,
                secure: false,
            },
        },
    },
};
