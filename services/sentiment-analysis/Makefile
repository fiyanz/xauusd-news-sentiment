.PHONY: all test data features train eval clean

all: test data features train eval

test:
	uv run pytest tests/ -v

data:
	uv run python -m src.acquire.price
	uv run python -m src.acquire.calendar
	uv run python -m src.acquire.news
	uv run python -m src.process.harmonize

features:
	uv run python -m src.features.build_features

train:
	uv run python -m src.models.train

eval:
	uv run python -m src.evaluate.evaluate_models

clean:
	rm -rf data/processed/* data/interim/* reports/*.md
