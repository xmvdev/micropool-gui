# micropool-gui
Minimal MoneroV Pool Windows GUI


![screenshot](https://github.com/xmvdev/micropool-gui/raw/master/screenshot.JPG)

To run micropool-gui as a nodejs/electronjs app:

    $ npm install electron -g
    $ git clone https://github.com/xmvdev/micropool-gui.git
    $ cd micropool-gui
    $ npm install
    $ npm start

To build the micropool as a standalone executable:

    $ npm install electron-builder -g
    $ git clone https://github.com/xmvdev/micropool-gui.git
    $ cd micropool-gui
    $ electron-builder --linux
    $ electron-builder --window
    $ electron-builder --mac
