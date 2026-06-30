package middleware

import "testing"

func TestIPSubnet(t *testing.T) {
	tests := map[string]string{
		"192.168.12.4":             "192.168.12.0/24",
		"192.168.12.250":           "192.168.12.0/24",
		"10.20.30.40":              "10.20.30.0/24",
		"2001:db8:abcd:12::1":      "2001:db8:abcd:12::/64",
		"2001:db8:abcd:12:ffff::1": "2001:db8:abcd:12::/64",
	}
	for input, expected := range tests {
		if got := ipSubnet(input); got != expected {
			t.Errorf("ipSubnet(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestSubnetBlockKeyGroupsIPv4Slash24(t *testing.T) {
	first := loginSubnetBlockKey("172.16.8.1")
	second := loginSubnetBlockKey("172.16.8.254")
	other := loginSubnetBlockKey("172.16.9.1")
	if first != second {
		t.Fatal("addresses in one /24 produced different block keys")
	}
	if first == other {
		t.Fatal("addresses in different /24 networks produced the same block key")
	}
}
