#!/usr/bin/env bash
#
# The pressure valve that makes a ~2 GB build survive on a 2 GB box.
#
# zram is a block device that lives in RAM and compresses everything written to
# it. Used as swap it does not touch the disk: pages the build is not actively
# touching get compressed in place instead of being evicted to nothing.
#
# Why this works here specifically: the thing that overflows is a V8 heap —
# JavaScript objects, module ASTs, strings. That compresses about 3:1 under
# zstd. So a 2 GB zram device backed by the same physical RAM buys roughly
# 1.3 GB of extra effective working set, which is the exact size of the
# shortfall measured in deploy/README.md.
#
# A small disk swapfile sits behind it as a genuine overflow. It is almost never
# touched, and it is what stands between a bad build and the OOM killer
# reaping sshd.
#
#   sudo deploy/zram-setup.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

ZRAM_SIZE="${ZRAM_SIZE:-2G}"
SWAPFILE_SIZE_MB="${SWAPFILE_SIZE_MB:-2048}"
SWAPFILE="${SWAPFILE:-/swapfile}"

echo "==> zram: ${ZRAM_SIZE} (zstd)"

modprobe zram || true

# systemd-zram-generator is the maintained path on Debian/Ubuntu/Fedora and
# survives reboots without a hand-written unit.
if [ -d /usr/lib/systemd/system-generators ] && \
   { [ -x /usr/lib/systemd/system-generators/zram-generator ] || apt-get -v >/dev/null 2>&1; }; then
	if ! [ -x /usr/lib/systemd/system-generators/zram-generator ]; then
		echo "    installing systemd-zram-generator"
		DEBIAN_FRONTEND=noninteractive apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y -qq systemd-zram-generator
	fi
	mkdir -p /etc/systemd
	cat > /etc/systemd/zram-generator.conf <<-EOF
	[zram0]
	zram-size = ${ZRAM_SIZE%G} * 1024
	compression-algorithm = zstd
	swap-priority = 100
	EOF
	systemctl daemon-reload
	systemctl restart /dev/zram0 2>/dev/null || systemctl start systemd-zram-setup@zram0.service || true
else
	echo "    zram-generator unavailable; configuring /dev/zram0 directly"
	zramctl --reset /dev/zram0 2>/dev/null || true
	zramctl --find --size "$ZRAM_SIZE" --algorithm zstd >/tmp/zramdev
	DEV="$(cat /tmp/zramdev)"
	mkswap "$DEV" >/dev/null
	swapon --priority 100 "$DEV"
fi

# --- disk overflow ----------------------------------------------------------
if [ ! -f "$SWAPFILE" ]; then
	echo "==> swapfile: ${SWAPFILE_SIZE_MB} MB at $SWAPFILE"
	fallocate -l "${SWAPFILE_SIZE_MB}M" "$SWAPFILE" 2>/dev/null \
		|| dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAPFILE_SIZE_MB" status=none
	chmod 600 "$SWAPFILE"
	mkswap "$SWAPFILE" >/dev/null
	# Lower priority than zram: the kernel fills compressed RAM first and only
	# spills to disk when that is exhausted.
	swapon --priority 10 "$SWAPFILE"
	grep -q "^$SWAPFILE" /etc/fstab || echo "$SWAPFILE none swap sw,pri=10 0 0" >> /etc/fstab
fi

# --- kernel tuning ----------------------------------------------------------
# swappiness 180 is the value the kernel documentation recommends once swap is
# compressed RAM rather than a disk: swapping is now cheap, so prefer it over
# evicting the page cache that is holding the 137 MB site.
cat > /etc/sysctl.d/99-evidence-zram.conf <<-'EOF'
vm.swappiness = 180
vm.watermark_boost_factor = 0
vm.watermark_scale_factor = 125
vm.page-cluster = 0
EOF
sysctl --quiet --load /etc/sysctl.d/99-evidence-zram.conf

echo
swapon --show || true
free -m || true
