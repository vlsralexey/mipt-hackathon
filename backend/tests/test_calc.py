from decimal import Decimal as D
from decimal import localcontext

import pytest

from app.config import Rules
from app.pipeline.calc import calculate, compute_stats, find_outliers, outlier_bounds


def ds(values):
    return list(map(D, values))


def test_small_sample_outliers_and_exact_boundary():
    assert find_outliers(ds(["100", "105", "300"]), Rules())[0] == {2}
    assert find_outliers(ds(["50", "100", "150"]), Rules())[0] == set()
    assert find_outliers([], Rules())[0] == set()


def test_iqr_and_original_sample_metadata():
    prices = ds(["98", "99", "100", "101", "102", "250"])
    excluded, text = find_outliers(prices, Rules())
    assert excluded == {5} and "IQR" in text
    kept = [price for i, price in enumerate(prices) if i not in excluded]
    result = calculate(kept, Rules(), outlier_prices=prices)
    assert result.stats.median == D("100.50")  # исходные шесть, а не оставшиеся пять
    assert result.stats.lower_bound == D("95.50")
    assert result.stats.upper_bound == D("105.50")
    assert result.stats.n == 5


def test_ok_sample_variance():
    result = calculate(ds(["100", "110", "90"]), Rules())
    assert result.status == "ok" and result.unit_price == D("100.00")
    assert result.stats.std == D("10.00") and result.stats.cv == D(".1000")
    assert result.reference_price is None


@pytest.mark.parametrize(
    "prices,status,reference",
    [
        (["100", "105"], "insufficient", "102.50"),
        (["100", "140", "60"], "heterogeneous", "100.00"),
        (["1.005"], "insufficient", "1.01"),
    ],
)
def test_unjustified(prices, status, reference):
    result = calculate(ds(prices), Rules())
    assert result.status == status and result.unit_price is None
    assert result.reference_price == D(reference)


def test_empty_and_zero():
    assert calculate([], Rules()).stats is None
    assert calculate([D(0)] * 3, Rules()).unit_price == D("0.00")
    assert compute_stats([D(5)], "rule").std == 0


def test_cv_threshold_uses_unrounded_value():
    # CV=0.33001 сериализуется как .3300, но не является однородным.
    result = calculate(ds(["66.999", "100", "133.001"]), Rules())
    assert result.stats.cv == D(".3300") and result.status == "heterogeneous"
    assert calculate(ds(["67", "100", "133"]), Rules()).status == "ok"


def test_fixed_data_is_repeatable_and_decimal_context_independent():
    prices = ds(["100.01", "100.02", "100.03"])
    expected = calculate(prices, Rules())
    with localcontext() as context:
        context.prec = 8
        assert calculate(prices, Rules()) == expected
    assert calculate(prices, Rules()) == expected


@pytest.mark.parametrize("price", ["NaN", "Infinity", "-1"])
def test_invalid_calculation_inputs(price):
    with pytest.raises(ValueError):
        calculate([D(price)], Rules())
    with pytest.raises(ValueError):
        outlier_bounds([D(price)], Rules())


def test_config_controls_outlier_thresholds():
    prices = ds(["100", "100", "130"])
    assert find_outliers(prices, Rules())[0] == set()
    assert find_outliers(prices, Rules(median_max_deviation=D(".2")))[0] == {2}
