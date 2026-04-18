require 'webrick'
Dir.chdir(File.dirname(__FILE__))
server = WEBrick::HTTPServer.new(Port: 3333, DocumentRoot: '.')
trap('INT') { server.shutdown }
server.start
