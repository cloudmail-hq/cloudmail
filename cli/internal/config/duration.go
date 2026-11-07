package config

import "time"

// Duration is stored as nanoseconds so the zero value means "unset" and the
// type can carry through JSON without pulling time formatting into the struct
// tags. These two helpers are the only bridge to time.Duration.

func parseGoDuration(s string) (int64, error) {
	d, err := time.ParseDuration(s)
	return int64(d), err
}

// String renders the duration the way a person writes it: "30s", "2m0s".
func (d Duration) String() string { return time.Duration(d.Value).String() }

// AsDuration converts to a time.Duration for use with net/http.
func (d Duration) AsDuration() time.Duration { return time.Duration(d.Value) }
