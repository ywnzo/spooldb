export function bootstrapScript({origin,artifact,invite=''}){
 const url=new URL(origin);if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('Invalid download origin');
 if(!/^[a-f0-9]{64}$/.test(artifact.sha256)||!/^[a-z0-9-]+\.run$/.test(artifact.name))throw Error('Invalid installer metadata');
 if(invite&&(invite.length>40000||!/^spool:\/\/(join|workspace)\/v1\/[A-Za-z0-9_-]+$/.test(invite)))throw Error('Invalid invitation');
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 return `#!/bin/sh
set -eu
umask 077
case "$(uname -sm)" in 'Linux x86_64') ;; *) echo 'SpoolDB currently supports Linux x86-64.' >&2; exit 1;; esac
for tool in curl sha256sum tar; do command -v "$tool" >/dev/null 2>&1 || { echo "Please install $tool and retry." >&2; exit 1; }; done
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/spool-download.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM
printf '%s\\n' 'Downloading SpoolDB…'
curl --fail --location --retry 3 --output "$tmp/installer.run" ${quote(url.origin+'/downloads/'+artifact.sha256+'/'+artifact.name)}
printf '%s  %s\\n' ${quote(artifact.sha256)} "$tmp/installer.run" | sha256sum --check --status || { echo 'Installer checksum mismatch; nothing was installed.' >&2; exit 1; }
${invite?`printf '%s\\n' ${quote(invite)} > "$tmp/invite.txt"\nsh "$tmp/installer.run" --invite-file "$tmp/invite.txt" "$@"`:'sh "$tmp/installer.run" "$@"'}
`;
}
